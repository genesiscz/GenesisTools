import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { bearerToken } from "@genesiscz/utils/device-pairing/client";
import { DeviceStore } from "@genesiscz/utils/device-pairing/device-store";
import { PairRequestSchema } from "@genesiscz/utils/device-pairing/types";
import { isMissingPathError } from "@genesiscz/utils/fs/canonical";
import {
    RequestBodyTooLargeError,
    readBoundedRequestText,
    readBoundedWebBody,
} from "@genesiscz/utils/http/bounded-body";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { ADMIN_API, PUBLISH_API, PUBLISH_SERVER_HEADER, PUBLISH_SERVER_ID } from "./api";
import { API_SEGMENT, isSnapshotId, KIND_ID_RE, originOf } from "./ids";
import type { KindServer } from "./kind";
import { installSnapshot, listSnapshotIds, migrateFlatDataDir, removeSnapshot } from "./snapshot-store";

const { log } = logger.scoped("publish-server");

export const ADMIN_SOCKET = "admin.sock";
export const DEVICES_FILE = "devices.json";
export const DEVICE_TOKEN_PREFIX = "gtshare_";
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 ** 3;
const PAIR_BODY_BYTES = 4096;
const ADMIN_DEVICE_RE = /^\/admin\/devices\/([^/]+)$/;

export interface PublishServerOptions {
    kinds: readonly KindServer[];
    dataDir: string;
    stateDir: string;
    /** An HTTP(S) origin. The deployed /<kind> suffix is also accepted. */
    publicBase: string;
    minFreeBytes?: number;
    /** The kind whose folders need to move from the old flat data directory. */
    legacyFlatKind?: string;
}

export interface PublishServerContext {
    kinds: ReadonlyMap<string, KindServer>;
    dataDir: string;
    origin: string;
    devices: DeviceStore;
    minFreeBytes: number;
}

export function parsePublicOrigin(publicBase: string, kindIds: readonly string[]): string {
    const error = () => new Error(`Expected an HTTP(S) origin or an origin followed by one of: ${kindIds.join(", ")}`);
    let url: URL;
    try {
        url = new URL(publicBase);
        originOf(publicBase);
    } catch {
        throw error();
    }

    const path = url.pathname.replace(/\/+$/, "");

    if (url.username || url.password || url.search || url.hash || (path && !kindIds.includes(path.slice(1)))) {
        throw error();
    }

    return url.origin;
}

export function createPublishServerContext(options: PublishServerOptions): PublishServerContext {
    const kinds = new Map<string, KindServer>();
    for (const server of options.kinds) {
        const id = server.kind.id;
        if (!KIND_ID_RE.test(id) || kinds.has(id)) {
            throw new Error(`Invalid or duplicate published kind id: ${id}`);
        }

        kinds.set(id, server);
    }

    if (kinds.size === 0 || (options.legacyFlatKind && !kinds.has(options.legacyFlatKind))) {
        throw new Error("Expected a configured published kind for this server");
    }

    return {
        kinds,
        dataDir: options.dataDir,
        origin: parsePublicOrigin(options.publicBase, [...kinds.keys()]),
        devices: new DeviceStore({ file: join(options.stateDir, DEVICES_FILE), tokenPrefix: DEVICE_TOKEN_PREFIX }),
        minFreeBytes: options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES,
    };
}

function respond(status: number, body: unknown): Response {
    const text = typeof body === "string";
    return new Response(text ? body : SafeJSON.stringify(body), {
        status,
        headers: {
            "Content-Type": text ? "text/plain; charset=utf-8" : "application/json",
            "Cache-Control": "no-store",
        },
    });
}

function notFound(): Response {
    return respond(404, "not found");
}

function decodedSegment(raw: string): string | null {
    try {
        return decodeURIComponent(raw);
    } catch (err) {
        log.debug({ err }, "invalid URL encoding");
        return null;
    }
}

async function pair(request: Request, devices: DeviceStore): Promise<Response> {
    const text = await readBoundedRequestText(request, PAIR_BODY_BYTES);
    let raw: unknown;
    try {
        raw = SafeJSON.parse(text || "{}", { strict: true });
    } catch {
        log.debug("pair request is not JSON");
        return respond(400, "code and deviceName required");
    }

    const parsed = PairRequestSchema.safeParse(raw);
    if (!parsed.success) {
        return respond(400, "code and deviceName required");
    }

    const result = await devices.pair(parsed.data.code, parsed.data.deviceName);
    return result ? respond(200, result) : respond(403, "wrong or expired pairing code");
}

async function routeApi(input: {
    request: Request;
    context: PublishServerContext;
    path: string;
    server: KindServer | undefined;
}): Promise<Response> {
    const { request, context, path, server } = input;
    const token = bearerToken(request);
    const device = token ? await context.devices.identify(token) : null;
    if (!device || !token) {
        return respond(401, "a paired device token is required");
    }

    if (path === PUBLISH_API.whoami && request.method === "GET") {
        return respond(200, { deviceId: device.id, name: device.name });
    }

    if (!server) {
        return notFound();
    }

    const kind = server.kind;
    const snapshots = PUBLISH_API.snapshots(kind.id);
    const location = { dataDir: context.dataDir, kind: kind.id };
    if (path === snapshots && request.method === "GET") {
        return respond(200, { ids: await listSnapshotIds(location) });
    }

    const id = path.startsWith(`${snapshots}/`) ? decodedSegment(path.slice(snapshots.length + 1)) : null;
    if (!id || !isSnapshotId(id) || (request.method !== "PUT" && request.method !== "DELETE")) {
        return notFound();
    }

    if (!(await context.devices.authenticate(token))) {
        return respond(401, "a paired device token is required");
    }

    if (request.method === "DELETE") {
        return (await removeSnapshot({ ...location, id })) ? respond(200, { id }) : notFound();
    }

    const body = await readBoundedWebBody(request, kind.maxUploadBytes);
    const outcome = await installSnapshot({
        dataDir: context.dataDir,
        kind,
        id,
        body,
        minFreeBytes: context.minFreeBytes,
    });
    log.info({ device: device.id, kind: kind.id, id, ok: outcome.ok }, "snapshot upload");
    return outcome.ok ? respond(200, { id, title: outcome.title }) : respond(outcome.status, outcome.error);
}

async function routePublic(request: Request, url: URL, context: PublishServerContext): Promise<Response> {
    const { pathname: path } = url;
    if (path === PUBLISH_API.health) {
        return request.method === "GET"
            ? respond(200, { server: PUBLISH_SERVER_ID, api: 1, kinds: [...context.kinds.keys()] })
            : notFound();
    }

    if (path === PUBLISH_API.pair) {
        return request.method === "POST" ? pair(request, context.devices) : notFound();
    }

    const [, kindId = "", id = "", ...rest] = path.split("/");
    const server = context.kinds.get(kindId);
    if (kindId === API_SEGMENT || id === API_SEGMENT) {
        return routeApi({ request, context, path, server });
    }

    if (path === "/robots.txt" && request.method === "GET") {
        return respond(200, "User-agent: *\nDisallow: /\n");
    }

    if (!server || !isSnapshotId(id) || (request.method !== "GET" && request.method !== "HEAD")) {
        return notFound();
    }

    const asGet = request.method === "HEAD" ? new Request(url, { method: "GET", headers: request.headers }) : request;
    const response = await server.serve({
        request: asGet,
        url,
        id,
        rest: rest.length ? `/${rest.join("/")}` : "",
        kindDir: join(context.dataDir, kindId),
        origin: context.origin,
    });
    return response ?? notFound();
}

async function handleRequest(request: Request, route: (url: URL) => Promise<Response>): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
        response = await route(url);
    } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
            response = respond(413, "too large");
        } else {
            log.error({ err, path: url.pathname }, "publish server request failed");
            response = respond(500, "the request failed");
        }
    }

    const headers = new Headers(response.headers);
    headers.set(PUBLISH_SERVER_HEADER, PUBLISH_SERVER_ID);
    headers.set("X-Robots-Tag", "noindex, nofollow");
    return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

export function handlePublishRequest(request: Request, context: PublishServerContext): Promise<Response> {
    return handleRequest(request, (url) => routePublic(request, url, context));
}

export function handleAdminRequest(request: Request, context: PublishServerContext): Promise<Response> {
    return handleRequest(request, async ({ pathname }) => {
        if (pathname === ADMIN_API.pairCode && request.method === "POST") {
            return respond(200, context.devices.createPairingCode());
        }

        if (pathname === ADMIN_API.devices && request.method === "GET") {
            const devices = await context.devices.list();
            return respond(200, { devices: devices.map(({ tokenHash: _hash, ...device }) => device) });
        }

        const match = ADMIN_DEVICE_RE.exec(pathname);
        const id = match?.[1] && decodedSegment(match[1]);
        if (id && request.method === "DELETE" && (await context.devices.revoke(id))) {
            return respond(200, { revoked: id });
        }

        return notFound();
    });
}

export interface RunningPublishServer {
    url: string;
    adminSocket: string;
    context: PublishServerContext;
    stop(): Promise<void>;
}

/** Remove an abandoned socket only after proving it has no listener. */
async function clearAbandonedSocket(path: string): Promise<void> {
    let socket: Awaited<ReturnType<typeof lstat>>;
    try {
        socket = await lstat(path);
    } catch (err) {
        if (isMissingPathError(err)) {
            return;
        }

        throw err;
    }

    if (!socket.isSocket()) {
        throw new Error(`Refusing to replace a non-socket file at ${path}`);
    }

    await new Promise<void>((resolve, reject) => {
        const client = createConnection({ path, signal: AbortSignal.timeout(1000) });
        client.once("connect", () => {
            client.destroy();
            reject(new Error(`A publish server is already listening at ${path}`));
        });
        client.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "ECONNREFUSED" || isMissingPathError(err)) {
                resolve();
            } else {
                reject(err);
            }
        });
    });

    await unlink(path).catch((err: unknown) => {
        if (!isMissingPathError(err)) {
            throw err;
        }
    });
}

export async function startPublishServer(
    options: PublishServerOptions & { port: number; host: string }
): Promise<RunningPublishServer> {
    const context = createPublishServerContext(options);
    await mkdir(options.dataDir, { recursive: true });
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    const adminSocket = join(options.stateDir, ADMIN_SOCKET);
    await clearAbandonedSocket(adminSocket);

    if (options.legacyFlatKind) {
        await migrateFlatDataDir({
            dataDir: options.dataDir,
            kind: options.legacyFlatKind,
            kindIds: [...context.kinds.keys()],
        });
    }

    const server = Bun.serve({
        hostname: options.host,
        port: options.port,
        maxRequestBodySize: Math.max(...options.kinds.map(({ kind }) => kind.maxUploadBytes)),
        fetch: (req) => handlePublishRequest(req, context),
    });

    let admin: ReturnType<typeof Bun.serve> | undefined;
    try {
        const listener = Bun.serve({ unix: adminSocket, fetch: (req) => handleAdminRequest(req, context) });
        admin = listener;
        await chmod(adminSocket, 0o600);
        log.info({ host: options.host, port: server.port, dataDir: options.dataDir }, "publish server listening");

        return {
            url: server.url.origin,
            adminSocket,
            context,
            stop: async () => {
                await Promise.all([server.stop(true), listener.stop(true)]);
            },
        };
    } catch (err) {
        await Promise.all([server.stop(true), admin?.stop(true)]);
        throw err;
    }
}

export async function adminRequest(input: { stateDir: string; path: string; method?: string }): Promise<unknown> {
    const res = await fetch(`http://localhost${input.path}`, {
        method: input.method ?? "GET",
        unix: join(input.stateDir, ADMIN_SOCKET),
        signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
        throw new Error(`publish server admin ${input.path}: HTTP ${res.status} ${await res.text()}`);
    }

    return res.json();
}
