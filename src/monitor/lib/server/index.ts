import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { listAiAccountOptions } from "@app/monitor/lib/checks/ai-provider";
import { runCheck } from "@app/monitor/lib/checks/run-check";
import { listStatuspageComponents } from "@app/monitor/lib/checks/statuspage";
import { Monitor } from "@app/monitor/lib/monitor";
import {
    getNotifySettings,
    parseNotifySettingsPatch,
    sendTestNotification,
    updateNotifySettings,
} from "@app/monitor/lib/notify-settings";
import { WATCHER_PRESETS } from "@app/monitor/lib/presets";
import { listSayVoices } from "@app/monitor/lib/say-voices";
import { Scheduler } from "@app/monitor/lib/scheduler";
import { isNotifyChannel, MONITOR_VERSION, type MonitorEvent, maskTarget, maskWatcher } from "@app/monitor/lib/types";
import {
    normalizeTarget,
    parseNotifyTargetInput,
    parseNotifyTargetPatch,
    parseWatcherInput,
    parseWatcherPatch,
    WatcherValidationError,
} from "@app/monitor/lib/validate";
import { env } from "@genesiscz/utils/env";
import { matchRoute } from "@genesiscz/utils/http/match-route";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { DASHBOARDS, WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";
import type { ServerWebSocket } from "bun";

export const DEFAULT_PORT = WEB_SERVICES["monitor-server"].port;
const CHECK_RETENTION_DAYS = 30;
const UI_DIST = resolve(import.meta.dirname, "..", "..", "ui", "dist");

/**
 * No CORS headers on purpose. The dashboard is always same-origin: `vite dev`
 * proxies `/api/` to this port, and the built bundle is served by this process.
 * `Access-Control-Allow-Origin: *` let ANY page the user had open read
 * `GET /api/v1/targets` (webhook URLs, telegram bot tokens) and POST new
 * targets at this loopback daemon.
 */
const LOOPBACK_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The pages allowed to talk to this daemon from a browser: the Vite dashboard
 * and this server's own static bundle, on any loopback alias. Another local
 * port is another program, not us.
 */
export function isAllowedBrowserOrigin(origin: string | null, ownPort: number): boolean {
    if (!origin) {
        // No Origin at all: curl, the CLI, a test. Not a browser page.
        return true;
    }

    try {
        const url = new URL(origin);
        const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
        const allowedPorts = new Set([DASHBOARDS.monitor.port, WEB_SERVICES["monitor-server"].port, ownPort]);

        return url.protocol === "http:" && LOOPBACK_ORIGIN_HOSTS.has(url.hostname) && allowedPorts.has(port);
    } catch {
        return false;
    }
}

/**
 * A browser cannot forge `Origin`, and a page on another site cannot read a
 * response without CORS headers. What is still reachable is the mutation side
 * of a "simple" cross-origin POST (`Content-Type: text/plain` skips the
 * preflight) and a WebSocket upgrade, which CORS never covered. Both are
 * refused unless the page is one of ours.
 */
function isForbiddenCrossOriginWrite(req: Request, ownPort: number): boolean {
    if (req.method === "GET" || req.method === "HEAD") {
        return false;
    }

    return !isAllowedBrowserOrigin(req.headers.get("origin"), ownPort);
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * DNS rebinding is what the `Origin` guard cannot see. A page on evil.example
 * whose name is re-pointed at 127.0.0.1 is SAME-origin to the browser, so it
 * sends no `Origin` at all and every read route answers it. What the attacker
 * cannot change is the `Host` the browser asks for: it is still the rebound
 * DNS name. Only an IP literal or a loopback name reaches this daemon, GET
 * included. A missing `Host` is HTTP/1.0 or a raw socket, never a browser.
 */
export function isAllowedHost(host: string | null): boolean {
    if (!host) {
        return true;
    }

    if (host.startsWith("[")) {
        return true;
    }

    const hostname = host.split(":")[0].toLowerCase();

    return IPV4_LITERAL.test(hostname) || hostname === "localhost" || hostname.endsWith(".localhost");
}

export interface StartServerOptions {
    port?: number;
    hostname?: string;
    dbPath?: string;
    /** Skip the scheduler (tests, one-shot API use). Default true. */
    schedule?: boolean;
}

export interface ServerHandle {
    port: number;
    monitor: Monitor;
    scheduler: Scheduler;
    stop(): Promise<void>;
}

type WsData = { scope: "events" };

function json(data: unknown, status = 200): Response {
    return new Response(SafeJSON.stringify(data, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function error(message: string, status: number, code?: string): Response {
    return json({ error: message, code }, status);
}

async function readBody(req: Request): Promise<unknown> {
    const text = await req.text();

    if (!text.trim()) {
        return {};
    }

    try {
        return SafeJSON.parse(text, { strict: true });
    } catch (parseError) {
        logger.debug({ parseError }, "monitor server: invalid JSON body");
        throw new WatcherValidationError("body is not valid JSON");
    }
}

function parseId(raw: string): number | null {
    const id = Number.parseInt(raw, 10);

    return Number.isInteger(id) && id > 0 ? id : null;
}

function parseLimit(url: URL, fallback: number): number {
    const raw = url.searchParams.get("limit");
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;

    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".woff2": "font/woff2",
};

/** Serves a built dashboard (`vite build` output) so one launchd process is enough. */
function serveStatic(pathname: string): Response | null {
    if (!existsSync(UI_DIST)) {
        return null;
    }

    const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const candidate = join(UI_DIST, relative);
    const file = existsSync(candidate) && extname(candidate) ? candidate : join(UI_DIST, "index.html");

    if (!file.startsWith(UI_DIST) || !existsSync(file)) {
        return null;
    }

    return new Response(Bun.file(file), {
        headers: { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" },
    });
}

async function handleWatcherRoutes(req: Request, url: URL, monitor: Monitor): Promise<Response | null> {
    const path = url.pathname;

    if (matchRoute(req, "GET", "/api/v1/watchers", path)) {
        return json({ watchers: (await monitor.db.summarizeAll()).map(maskWatcher) });
    }

    if (matchRoute(req, "POST", "/api/v1/watchers", path)) {
        const input = parseWatcherInput(await readBody(req));
        const watcher = await monitor.createWatcher(input);
        // First check right away so the card never sits on "unknown".
        void monitor.runWatcher(watcher).catch((runError) => {
            logger.warn({ runError, id: watcher.id }, "monitor server: initial check failed");
        });

        return json({ watcher: maskWatcher(watcher) }, 201);
    }

    const single = matchRoute(req, "GET", "/api/v1/watchers/:id", path);

    if (single) {
        const id = parseId(single.id);
        const watcher = id ? await monitor.getSummary(id) : null;

        return watcher ? json({ watcher: maskWatcher(watcher) }) : error("watcher not found", 404);
    }

    const patch = matchRoute(req, "PATCH", "/api/v1/watchers/:id", path);

    if (patch) {
        const id = parseId(patch.id);
        const current = id ? await monitor.getWatcher(id) : null;

        if (!current) {
            return error("watcher not found", 404);
        }

        const watcher = await monitor.updateWatcher(current.id, parseWatcherPatch(await readBody(req), current.kind));

        return json({ watcher: watcher ? maskWatcher(watcher) : watcher });
    }

    const remove = matchRoute(req, "DELETE", "/api/v1/watchers/:id", path);

    if (remove) {
        const id = parseId(remove.id);
        const deleted = id ? await monitor.deleteWatcher(id) : false;

        return deleted ? json({ ok: true }) : error("watcher not found", 404);
    }

    const run = matchRoute(req, "POST", "/api/v1/watchers/:id/run", path);

    if (run) {
        const id = parseId(run.id);
        const outcome = id ? await monitor.runWatcher(id) : null;

        if (!outcome) {
            const exists = id ? await monitor.getWatcher(id) : null;

            return exists ? error("check already running", 409, "CHECK_IN_FLIGHT") : error("watcher not found", 404);
        }

        return json({ ...outcome, watcher: maskWatcher(outcome.watcher) });
    }

    const checks = matchRoute(req, "GET", "/api/v1/watchers/:id/checks", path);

    if (checks) {
        const id = parseId(checks.id);

        if (!id || !(await monitor.getWatcher(id))) {
            return error("watcher not found", 404);
        }

        const since = url.searchParams.get("since") ?? undefined;

        return json({ checks: await monitor.db.listChecks(id, { limit: parseLimit(url, 200), since }) });
    }

    const incidents = matchRoute(req, "GET", "/api/v1/watchers/:id/incidents", path);

    if (incidents) {
        const id = parseId(incidents.id);

        if (!id || !(await monitor.getWatcher(id))) {
            return error("watcher not found", 404);
        }

        return json({ incidents: await monitor.db.listIncidents({ watcherId: id, limit: parseLimit(url, 50) }) });
    }

    const items = matchRoute(req, "GET", "/api/v1/watchers/:id/items", path);

    if (items) {
        const id = parseId(items.id);

        if (!id || !(await monitor.getWatcher(id))) {
            return error("watcher not found", 404);
        }

        return json({ items: await monitor.db.listFeedItems(id, parseLimit(url, 50)) });
    }

    return null;
}

async function handleTargetRoutes(req: Request, url: URL, monitor: Monitor): Promise<Response | null> {
    const path = url.pathname;

    if (matchRoute(req, "GET", "/api/v1/targets", path)) {
        return json({ targets: (await monitor.listTargets()).map(maskTarget) });
    }

    if (matchRoute(req, "POST", "/api/v1/targets", path)) {
        const created = await monitor.createTarget(parseNotifyTargetInput(await readBody(req)));

        return json({ target: maskTarget(created) }, 201);
    }

    const patch = matchRoute(req, "PATCH", "/api/v1/targets/:id", path);

    if (patch) {
        const id = parseId(patch.id);
        const current = id ? await monitor.getTarget(id) : null;

        if (!current) {
            return error("target not found", 404);
        }

        const target = await monitor.updateTarget(
            current.id,
            parseNotifyTargetPatch(await readBody(req), current.channel)
        );

        return json({ target: target ? maskTarget(target) : target });
    }

    const remove = matchRoute(req, "DELETE", "/api/v1/targets/:id", path);

    if (remove) {
        const id = parseId(remove.id);
        const deleted = id ? await monitor.deleteTarget(id) : false;

        return deleted ? json({ ok: true }) : error("target not found", 404);
    }

    const test = matchRoute(req, "POST", "/api/v1/targets/:id/test", path);

    if (test) {
        const id = parseId(test.id);
        const target = id ? await monitor.testTarget(id) : null;

        return target ? json({ sent: true, target: maskTarget(target) }) : error("target not found", 404);
    }

    return null;
}

export async function handleApiRequest(req: Request, url: URL, monitor: Monitor, startedAt: number): Promise<Response> {
    const path = url.pathname;

    if (path === "/api/v1/healthz") {
        return json({ ok: true, uptimeMs: Date.now() - startedAt, version: MONITOR_VERSION });
    }

    if (matchRoute(req, "GET", "/api/v1/overview", path)) {
        const overview = await monitor.overview();

        return json({ ...overview, watchers: overview.watchers.map(maskWatcher) });
    }

    if (matchRoute(req, "GET", "/api/v1/presets", path)) {
        return json({ presets: WATCHER_PRESETS });
    }

    if (matchRoute(req, "GET", "/api/v1/ai-accounts", path)) {
        return json({ accounts: await listAiAccountOptions() });
    }

    if (matchRoute(req, "GET", "/api/v1/notifications", path)) {
        return json({ settings: await getNotifySettings() });
    }

    if (matchRoute(req, "PATCH", "/api/v1/notifications", path)) {
        return json({ settings: await updateNotifySettings(parseNotifySettingsPatch(await readBody(req))) });
    }

    if (matchRoute(req, "POST", "/api/v1/notifications/test", path)) {
        const channel = url.searchParams.get("channel");
        const only = channel !== null && isNotifyChannel(channel) ? channel : undefined;

        if (channel !== null && !only) {
            return error("channel must be system, say, telegram or webhook", 400);
        }

        return json(await sendTestNotification(only));
    }

    if (matchRoute(req, "GET", "/api/v1/say-voices", path)) {
        return json({ providers: await listSayVoices({ fresh: url.searchParams.get("fresh") === "1" }) });
    }

    if (matchRoute(req, "GET", "/api/v1/incidents", path)) {
        const openOnly = url.searchParams.get("open") === "1";

        return json({ incidents: await monitor.db.listIncidents({ openOnly, limit: parseLimit(url, 100) }) });
    }

    if (matchRoute(req, "POST", "/api/v1/check", path)) {
        const input = parseWatcherInput(await readBody(req));

        return json({ check: await runCheck(input) });
    }

    if (matchRoute(req, "POST", "/api/v1/statuspage/components", path)) {
        const body = (await readBody(req)) as { target?: unknown };

        if (typeof body.target !== "string") {
            return error("target is required", 400);
        }

        const target = normalizeTarget("statuspage", body.target);

        try {
            return json(await listStatuspageComponents(target));
        } catch (fetchError) {
            return error(fetchError instanceof Error ? fetchError.message : String(fetchError), 502);
        }
    }

    const watcherResponse = await handleWatcherRoutes(req, url, monitor);

    if (watcherResponse) {
        return watcherResponse;
    }

    const targetResponse = await handleTargetRoutes(req, url, monitor);

    if (targetResponse) {
        return targetResponse;
    }

    return error("not found", 404);
}

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
    const monitor = new Monitor({ dbPath: opts.dbPath });
    const scheduler = new Scheduler(monitor);
    const startedAt = Date.now();
    const sockets = new Set<ServerWebSocket<WsData>>();
    const port = opts.port ?? DEFAULT_PORT;
    const hostname = opts.hostname ?? "127.0.0.1";

    await monitor.db.pruneChecks(CHECK_RETENTION_DAYS);

    const offEvents = monitor.on((event: MonitorEvent) => {
        const payload = SafeJSON.stringify(event, { strict: true });

        for (const ws of sockets) {
            // Per socket: a tab that closed between the `close` handler and this
            // event throws here, and one dead socket must not cost every socket
            // later in the Set its copy of the event.
            try {
                ws.send(payload);
            } catch (sendError) {
                logger.debug({ sendError, type: event.type }, "monitor server: event send failed, dropping socket");
                sockets.delete(ws);
            }
        }
    });

    const server = Bun.serve<WsData>({
        port,
        hostname,
        websocket: {
            open(ws) {
                sockets.add(ws);
                ws.send(SafeJSON.stringify({ type: "hello", protocolVersion: 1 } satisfies MonitorEvent));
            },
            close(ws) {
                sockets.delete(ws);
            },
            message(ws, raw) {
                if (String(raw).includes('"ping"')) {
                    ws.send(SafeJSON.stringify({ type: "pong" } satisfies MonitorEvent));
                }
            },
        },
        async fetch(req, bunServer): Promise<Response | undefined> {
            const url = new URL(req.url);

            if (req.method === "OPTIONS") {
                return new Response(null, { status: 204 });
            }

            if (!isAllowedHost(req.headers.get("host"))) {
                logger.warn(
                    { host: req.headers.get("host"), method: req.method, path: url.pathname },
                    "monitor server: refused a request for a foreign host name"
                );

                return error("this daemon only answers on loopback", 403);
            }

            if (isForbiddenCrossOriginWrite(req, bunServer.port ?? port)) {
                logger.warn(
                    { origin: req.headers.get("origin"), method: req.method, path: url.pathname },
                    "monitor server: refused a cross-origin write"
                );

                return error("cross-origin writes are not allowed", 403);
            }

            if (url.pathname === "/api/v1/events") {
                if (!isAllowedBrowserOrigin(req.headers.get("origin"), bunServer.port ?? port)) {
                    return error("cross-origin websocket upgrades are not allowed", 403);
                }

                if (bunServer.upgrade(req, { data: { scope: "events" } })) {
                    return undefined;
                }

                return error("expected websocket", 426);
            }

            if (url.pathname.startsWith("/api/")) {
                try {
                    return await handleApiRequest(req, url, monitor, startedAt);
                } catch (routeError) {
                    if (routeError instanceof WatcherValidationError) {
                        return error(routeError.message, 400, routeError.code);
                    }

                    logger.error({ routeError, path: url.pathname }, "monitor server: route failed");

                    return error(routeError instanceof Error ? routeError.message : String(routeError), 500);
                }
            }

            return serveStatic(url.pathname) ?? error("not found", 404);
        },
    });

    if (opts.schedule !== false) {
        scheduler.start();
    }

    logger.info({ port: server.port, hostname, db: monitor.db.path, uiDist: existsSync(UI_DIST) }, "monitor server up");

    return {
        port: server.port ?? port,
        monitor,
        scheduler,
        async stop() {
            scheduler.stop();
            await scheduler.drain();
            offEvents();

            for (const ws of sockets) {
                ws.close();
            }

            sockets.clear();
            server.stop(true);
            monitor.close();
        },
    };
}

if (import.meta.main) {
    const portFlagIndex = process.argv.indexOf("--port");
    const rawPort = portFlagIndex >= 0 ? process.argv[portFlagIndex + 1] : env.node.getPort();
    const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN;
    const handle = await startServer({ port: Number.isNaN(parsedPort) ? undefined : parsedPort });
    let stopping = false;
    const shutdown = async (): Promise<void> => {
        if (stopping) {
            return;
        }

        stopping = true;
        await handle.stop();
        process.exit(0);
    };

    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
}
