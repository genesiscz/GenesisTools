import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ADMIN_API, PairRequestSchema, SHARE_API } from "@app/dev-dashboard/lib/share/server/api";
import { ShareDeviceStore } from "@app/dev-dashboard/lib/share/server/devices";
import {
    installSnapshotUpload,
    listSnapshotSlugs,
    MAX_SNAPSHOT_UPLOAD_BYTES,
    removeSnapshot,
} from "@app/dev-dashboard/lib/share/server/upload";
import { snapshotShareSource } from "@app/dev-dashboard/lib/share/snapshot";
import { RequestBodyTooLargeError, readBoundedWebBody } from "@app/dev-dashboard/server/adapters/body-reader";
import { routerToResponse } from "@app/dev-dashboard/server/adapters/bun-serve";
import { defaultSystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";
import { Router } from "@app/dev-dashboard/server/router";
import { shareRoutes } from "@app/dev-dashboard/server/routes/share";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("share-server");

/** Every answer carries it, so `share-server status` knows the port is this server and not another. */
export const SHARE_SERVER_HEADER = "X-Share-Server";
const SERVER_ID = "genesis-tools";
const PAIR_BODY_BYTES = 4096;
const ADMIN_DEVICE_RE = /^\/admin\/devices\/([^/]+)$/;

export const ADMIN_SOCKET = "admin.sock";
export const DEVICES_FILE = "devices.json";

const PAGE_PATH_RE = /^\/[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * `https://share.example.com/md` -> origin `https://share.example.com` and page path `/md`: pages are
 * `<pagePath>/<slug>`, the upload API `<pagePath>/_api/...`. The path is one segment, so another kind of share
 * (`/artifact`) can live beside it on the same host later.
 */
export function parsePublicBase(publicBase: string): { origin: string; pagePath: string } {
    const url = new URL(publicBase);
    const pagePath = url.pathname.replace(/\/+$/, "");

    if (!PAGE_PATH_RE.test(pagePath)) {
        throw new Error(
            `--public-base must be an origin plus one path segment, e.g. https://share.example.com/md (got ${publicBase})`
        );
    }

    return { origin: url.origin, pagePath };
}

export interface ShareServerContext {
    dataDir: string;
    pagePath: string;
    devices: ShareDeviceStore;
    router: Router;
}

export function createShareServerContext(options: {
    dataDir: string;
    stateDir: string;
    publicBase: string;
}): ShareServerContext {
    const { origin, pagePath } = parsePublicBase(options.publicBase);
    const source = snapshotShareSource({ dataDir: options.dataDir, publicOrigin: origin });

    return {
        dataDir: options.dataDir,
        pagePath,
        devices: new ShareDeviceStore(join(options.stateDir, DEVICES_FILE)),
        router: new Router().addAll(shareRoutes(source, { pagePath })),
    };
}

function respond(status: number, body: unknown): Response {
    return new Response(typeof body === "string" ? body : SafeJSON.stringify(body), {
        status,
        headers: {
            "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
            "Cache-Control": "no-store",
        },
    });
}

const NOT_FOUND = (): Response => respond(404, "not found");

function bearer(req: Request): string | null {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer (\S+)$/.exec(header);

    return match?.[1] ?? null;
}

async function handleApi(req: Request, ctx: ShareServerContext, pathname: string): Promise<Response> {
    if (pathname === `${ctx.pagePath}${SHARE_API.pair}` && req.method === "POST") {
        const parsed = PairRequestSchema.safeParse(
            SafeJSON.parse(new TextDecoder().decode(await readBoundedWebBody(req, PAIR_BODY_BYTES)) || "{}", {
                strict: true,
            })
        );

        if (!parsed.success) {
            return respond(400, "code and deviceName required");
        }

        const paired = await ctx.devices.pair(parsed.data.code, parsed.data.deviceName);

        return paired ? respond(200, paired) : respond(403, "wrong or expired pairing code");
    }

    const token = bearer(req);
    const device = token ? await ctx.devices.authenticate(token) : null;

    if (!device) {
        return respond(401, "a paired device token is required");
    }

    if (pathname === `${ctx.pagePath}${SHARE_API.snapshots}` && req.method === "GET") {
        return respond(200, { slugs: await listSnapshotSlugs(ctx.dataDir) });
    }

    const prefix = `${ctx.pagePath}${SHARE_API.snapshots}/`;
    const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
    const slugMatch = /^([^/]+)$/.exec(rest);

    if (!slugMatch?.[1]) {
        return NOT_FOUND();
    }

    const slug = decodeURIComponent(slugMatch[1]);

    if (req.method === "PUT") {
        const body = await readBoundedWebBody(req, MAX_SNAPSHOT_UPLOAD_BYTES);
        const outcome = await installSnapshotUpload({ dataDir: ctx.dataDir, slug, body });
        log.info({ device: device.id, slug, ok: outcome.ok }, "share upload");

        return outcome.ok
            ? respond(200, { slug, title: outcome.manifest.title })
            : respond(outcome.status, outcome.error);
    }

    if (req.method === "DELETE") {
        return (await removeSnapshot({ dataDir: ctx.dataDir, slug })) ? respond(200, { slug }) : NOT_FOUND();
    }

    return NOT_FOUND();
}

/**
 * The public face: GET/HEAD `/share/<slug>` (with its `?asset`, `?view`, `?download` variants) rendered from the
 * snapshots, and the upload API under `/share/_api/` for paired devices. Every other path answers 404.
 */
export async function handleShareRequest(req: Request, ctx: ShareServerContext): Promise<Response> {
    const url = new URL(req.url);
    let res: Response;

    try {
        if (url.pathname.startsWith(`${ctx.pagePath}/_api/`)) {
            res = await handleApi(req, ctx, url.pathname);
        } else if (req.method === "GET" || req.method === "HEAD") {
            const asGet = req.method === "HEAD" ? new Request(req.url, { method: "GET", headers: req.headers }) : req;
            const routed = await routerToResponse(ctx.router, asGet, {
                services: { collector: defaultSystemCollector() },
            });
            res = routed ?? NOT_FOUND();

            if (req.method === "HEAD") {
                res = new Response(null, { status: res.status, headers: res.headers });
            }
        } else {
            res = NOT_FOUND();
        }
    } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
            res = respond(413, "too large");
        } else {
            log.error({ err, path: url.pathname }, "share server request failed");
            res = respond(500, "the request failed");
        }
    }

    res.headers.set(SHARE_SERVER_HEADER, SERVER_ID);

    return res;
}

/** The admin face, on a unix socket only the server's own user (and root) can open: pairing codes and devices. */
export async function handleAdminRequest(req: Request, ctx: ShareServerContext): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === ADMIN_API.pairCode && req.method === "POST") {
        return respond(200, ctx.devices.createPairingCode());
    }

    if (pathname === ADMIN_API.devices && req.method === "GET") {
        const devices = await ctx.devices.list();

        return respond(200, { devices: devices.map(({ tokenHash: _hash, ...device }) => device) });
    }

    const match = ADMIN_DEVICE_RE.exec(pathname);

    if (match?.[1] && req.method === "DELETE") {
        return (await ctx.devices.revoke(decodeURIComponent(match[1])))
            ? respond(200, { revoked: match[1] })
            : NOT_FOUND();
    }

    return NOT_FOUND();
}

export interface RunningShareServer {
    url: string;
    adminSocket: string;
    context: ShareServerContext;
    stop(): Promise<void>;
}

export async function startShareServer(options: {
    dataDir: string;
    stateDir: string;
    publicBase: string;
    port: number;
    host: string;
}): Promise<RunningShareServer> {
    const context = createShareServerContext(options);
    await mkdir(options.dataDir, { recursive: true });
    await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
    const adminSocket = join(options.stateDir, ADMIN_SOCKET);
    // A socket left by a server that died; ours, in our own state folder.
    await rm(adminSocket, { force: true });

    const server = Bun.serve({
        hostname: options.host,
        port: options.port,
        maxRequestBodySize: MAX_SNAPSHOT_UPLOAD_BYTES,
        fetch: (req) => handleShareRequest(req, context),
    });
    const admin = Bun.serve({ unix: adminSocket, fetch: (req) => handleAdminRequest(req, context) });
    await chmod(adminSocket, 0o600);
    log.info({ host: options.host, port: server.port, dataDir: options.dataDir }, "share server listening");

    return {
        url: `http://${options.host}:${server.port}`,
        adminSocket,
        context,
        stop: async () => {
            await server.stop(true);
            await admin.stop(true);
        },
    };
}

/** Ask a running server's admin socket (`share-server pair`, `share-server devices`). */
export async function adminRequest(options: { stateDir: string; path: string; method?: string }): Promise<unknown> {
    const res = await fetch(`http://localhost${options.path}`, {
        method: options.method ?? "GET",
        unix: join(options.stateDir, ADMIN_SOCKET),
        signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
        throw new Error(`share server admin ${options.path}: HTTP ${res.status} ${await res.text()}`);
    }

    return res.json();
}
