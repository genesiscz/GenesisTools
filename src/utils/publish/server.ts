import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { bearerToken } from "@genesiscz/utils/device-pairing/client";
import { DeviceStore } from "@genesiscz/utils/device-pairing/device-store";
import { PairRequestSchema } from "@genesiscz/utils/device-pairing/types";
import { isMissingPathError } from "@genesiscz/utils/fs/canonical";
import type { ShareServerConfig } from "@genesiscz/utils/genesis-tools/publish/store";
import {
    RequestBodyTooLargeError,
    readBoundedRequestText,
    readBoundedWebBody,
} from "@genesiscz/utils/http/bounded-body";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { ADMIN_API, PUBLISH_API, PUBLISH_SERVER_HEADER, PUBLISH_SERVER_ID } from "./api";
import { type AuditRecord, clientAddress, recordAudit } from "./audit";
import { API_SEGMENT, isSnapshotId, KIND_ID_RE, originOf } from "./ids";
import type { KindServer } from "./kind";
import { installSnapshot, listSnapshotIds, migrateFlatDataDir, removeSnapshot } from "./snapshot-store";

const { log } = logger.scoped("publish-server");

export const ADMIN_SOCKET = "admin.sock";
export const DEVICES_FILE = "devices.json";
export const DEVICE_TOKEN_PREFIX = "gtshare_";
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 ** 3;
const PAIR_BODY_BYTES = 4096;
const PAIR_WINDOW_MS = 10 * 60_000;
const PAIR_ATTEMPTS = 5;
const PAIR_ADDRESS_LIMIT = 10_000;

interface RequestTrace {
    address?: string;
    device?: { id: string; name: string };
    token?: string;
    sensitive: string[];
}

class PairRateLimit {
    private readonly entries = new Map<string, number[]>();
    private reapAt = 0;

    allow(address: string | undefined): boolean {
        const key = address ?? "unknown";
        const now = Date.now();
        const cutoff = now - PAIR_WINDOW_MS;
        if (now >= this.reapAt) {
            for (const [entry, times] of this.entries) {
                if ((times.at(-1) ?? 0) <= cutoff) {
                    this.entries.delete(entry);
                }
            }

            this.reapAt = now + PAIR_WINDOW_MS;
        }

        const previous = this.entries.get(key);
        if (!previous && this.entries.size >= PAIR_ADDRESS_LIMIT) {
            return false;
        }

        const recent = previous?.filter((at) => at > cutoff) ?? [];
        if (recent.length >= PAIR_ATTEMPTS) {
            return false;
        }

        this.entries.set(key, [...recent, now]);
        return true;
    }
}
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
    stateDir: string;
    pairRateLimit: PairRateLimit;
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

export function serverOptionsFrom(
    server: ShareServerConfig,
    kinds: readonly KindServer[]
): PublishServerOptions & { port: number; host: string } {
    const byId = new Map(kinds.map((entry) => [entry.kind.id, entry]));
    const selected = server.kinds.map((id) => {
        const kind = byId.get(id);
        if (!kind) {
            throw new Error(`This publish server cannot serve kind "${id}"`);
        }

        return kind;
    });

    return {
        kinds: selected,
        dataDir: server.dataDir,
        stateDir: server.stateDir,
        publicBase: server.publicOrigin,
        legacyFlatKind: server.kinds.includes("md") ? "md" : undefined,
        minFreeBytes: Math.ceil(server.minFreeGb * 1024 ** 3),
        ...server.listen,
    };
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
        stateDir: options.stateDir,
        pairRateLimit: new PairRateLimit(),
    };
}

function respond(status: number, body: unknown): Response {
    const text = typeof body === "string";
    const content = text ? body : SafeJSON.stringify(body);
    return new Response(content, {
        status,
        headers: {
            "Content-Type": text ? "text/plain; charset=utf-8" : "application/json",
            "Cache-Control": "no-store",
            "Content-Length": String(Buffer.byteLength(content)),
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

async function pair(request: Request, devices: DeviceStore, trace: RequestTrace): Promise<Response> {
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

    const code = parsed.data.code;
    trace.sensitive.push(code, code.replaceAll(/[^A-Za-z0-9]/g, ""));
    const result = await devices.pair(parsed.data.code, parsed.data.deviceName);
    if (result) {
        trace.device = { id: result.deviceId, name: parsed.data.deviceName };
        trace.sensitive.push(result.token);
    }

    return result ? respond(200, result) : respond(403, "wrong or expired pairing code");
}

async function routeApi(input: {
    request: Request;
    context: PublishServerContext;
    path: string;
    server: KindServer | undefined;
    trace: RequestTrace;
}): Promise<Response> {
    const { request, context, path, server, trace } = input;
    const { device, token } = trace;
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

async function routePublic(
    request: Request,
    url: URL,
    context: PublishServerContext,
    trace: RequestTrace
): Promise<Response> {
    const { pathname: path } = url;
    if (path === PUBLISH_API.health) {
        return request.method === "GET"
            ? respond(200, { server: PUBLISH_SERVER_ID, api: 1, kinds: [...context.kinds.keys()] })
            : notFound();
    }

    if (path === PUBLISH_API.pair) {
        if (request.method !== "POST") {
            return notFound();
        }

        if (!context.pairRateLimit.allow(trace.address)) {
            const limited = respond(429, "too many pairing attempts");
            limited.headers.set("Retry-After", String(PAIR_WINDOW_MS / 1000));
            return limited;
        }

        return pair(request, context.devices, trace);
    }

    const [, kindId = "", id = "", ...rest] = path.split("/");
    const server = context.kinds.get(kindId);
    if (kindId === API_SEGMENT || id === API_SEGMENT) {
        return routeApi({ request, context, path, server, trace });
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

async function auditedBody(
    body: ReadableStream<Uint8Array> | null,
    size: string | null,
    finish: (bytes: number) => Promise<void>
) {
    if (!body) {
        await finish(0);
        return null;
    }

    if (size !== null && /^\d+$/.test(size)) {
        await finish(Number(size));
        return body;
    }

    const reader = body.getReader();
    let bytes = 0;
    let finished = false;
    const close = async () => {
        if (!finished) {
            finished = true;
            await finish(bytes);
        }
    };
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const item = await reader.read();
                if (item.done) {
                    await close();
                    controller.close();
                } else {
                    bytes += item.value.byteLength;
                    controller.enqueue(item.value);
                }
            } catch (err) {
                await close();
                controller.error(err);
            }
        },
        async cancel(reason) {
            try {
                await reader.cancel(reason);
            } finally {
                await close();
            }
        },
    });
}

async function handleRequest(input: {
    request: Request;
    context: PublishServerContext;
    peer?: string;
    admin?: boolean;
    route: (url: URL, trace: RequestTrace) => Promise<Response>;
}): Promise<Response> {
    const { request, context } = input;
    const url = new URL(request.url);
    const started = Date.now();
    const clock = performance.now();
    const token = bearerToken(request) ?? undefined;
    const trace: RequestTrace = {
        address: clientAddress(input.peer, request.headers.get("x-forwarded-for")),
        sensitive: token ? [token] : [],
        token,
    };
    let response: Response;
    try {
        if (!input.admin && token) {
            trace.device = (await context.devices.identify(token)) ?? undefined;
        }
        response = await input.route(url, trace);
    } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
            response = respond(413, "too large");
        } else {
            log.error({ errorName: err instanceof Error ? err.name : undefined }, "publish server request failed");
            response = respond(500, "the request failed");
        }
    }

    const headers = new Headers(response.headers);
    headers.set(PUBLISH_SERVER_HEADER, PUBLISH_SERVER_ID);
    headers.set("X-Robots-Tag", "noindex, nofollow");
    headers.set("X-Content-Type-Options", "nosniff");
    const [, segment, second, operation, snapshot] = url.pathname.split("/");
    const kind = context.kinds.has(segment) ? segment : undefined;
    const rawId = second === API_SEGMENT ? (operation === "snapshots" ? snapshot : undefined) : second;
    const id = kind && rawId && isSnapshotId(rawId) ? rawId : undefined;
    const action: AuditRecord["action"] = input.admin
        ? "admin"
        : url.pathname === PUBLISH_API.pair && request.method === "POST"
          ? "pair"
          : "request";
    const body = await auditedBody(
        request.method === "HEAD" ? null : response.body,
        headers.get("content-length"),
        (bytesOut) =>
            recordAudit(
                context.stateDir,
                {
                    time: new Date(started).toISOString(),
                    side: "server",
                    action,
                    address: input.admin ? "local" : trace.address,
                    method: request.method,
                    path: url.pathname,
                    kind,
                    id,
                    deviceId: trace.device?.id,
                    deviceName: trace.device?.name,
                    status: response.status,
                    bytesOut,
                    durationMs: performance.now() - clock,
                    userAgent: request.headers.get("user-agent") ?? undefined,
                },
                { sensitive: trace.sensitive }
            )
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export function handlePublishRequest(
    request: Request,
    context: PublishServerContext,
    peer?: string
): Promise<Response> {
    return handleRequest({ request, context, peer, route: (url, trace) => routePublic(request, url, context, trace) });
}

export function handleAdminRequest(request: Request, context: PublishServerContext): Promise<Response> {
    return handleRequest({
        request,
        context,
        admin: true,
        route: async ({ pathname }) => {
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
        },
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
    await chmod(options.stateDir, 0o700);
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
        fetch: (req, listener) => handlePublishRequest(req, context, listener.requestIP(req)?.address),
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
