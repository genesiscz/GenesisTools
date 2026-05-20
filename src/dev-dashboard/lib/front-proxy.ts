import { type DashboardAuthProvision, getDashboardAuthCached } from "@app/dev-dashboard/config";
import {
    type CompleteDashboardAuthConfig,
    isCompleteAuthConfig,
    LOCAL_ORIGIN_HEADER,
    verifyBasicAuthHeader,
    verifySessionToken,
} from "@app/dev-dashboard/lib/auth";
import { getTtydPort } from "@app/dev-dashboard/lib/ttyd/manager";
import { logger } from "@app/logger";
import type { Server, ServerWebSocket } from "bun";

// Bun's node:http upgrade socket is a no-op (oven-sh/bun#28396 / PR #28347),
// so a Vite-middleware reverse proxy can't relay WebSockets. This front proxy
// runs on the public port using Bun's *native* server.upgrade (unaffected),
// forwards plain HTTP to the internal Vite server, serves /ttyd/<id>/* straight
// from the loopback ttyd session, and bridges every WebSocket (ttyd + Vite HMR)
// to its upstream frame-for-frame.

const TTYD_PATH = /^\/ttyd\/([0-9a-fA-F-]{36})(?:\/|$)/;

// LOCAL_ORIGIN_HEADER is the single source of truth in auth.ts (set/stripped
// here, trusted by the Vite middleware — they must never desync).

const WWW_AUTHENTICATE = 'Basic realm="GenesisTools dev dashboard", charset="UTF-8"';

function isLoopbackAddress(address: string | undefined): boolean {
    if (!address) {
        return false;
    }

    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// True only for a real loopback hit: loopback socket AND localhost Host AND no
// Cloudflare/forwarded edge headers. cloudflared connects from 127.0.0.1 too,
// so the socket alone is insufficient — the un-strippable cf-*/cdn-loop headers
// and the original Host are what separate a local browser from tunnel/LAN.
export function isLoopbackOnlyOrigin(req: Request, clientAddress: string | undefined): boolean {
    if (!isLoopbackAddress(clientAddress)) {
        return false;
    }

    if (
        req.headers.get("cf-ray") ||
        req.headers.get("cf-connecting-ip") ||
        req.headers.get("cf-visitor") ||
        req.headers.get("cdn-loop") ||
        req.headers.get("x-forwarded-for")
    ) {
        return false;
    }

    const hostname = (req.headers.get("host") ?? "")
        .replace(/:\d+$/, "")
        .replace(/^\[|\]$/g, "")
        .toLowerCase();

    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export type AuthDecision = "allow" | "deny" | "unconfigured";

// Pure auth decision (no I/O) so the full gate matrix is unit-testable and
// can't silently regress. ttyd HTTP assets and EVERY WebSocket upgrade (ttyd
// terminal + Vite HMR) are served/bridged by this proxy and never reach the
// Vite auth middleware, so without this gate they are an unauthenticated
// bypass (proven: interactive shell over LAN and the public tunnel). Accept a
// genuine loopback origin, a valid Basic header (curl/programmatic clients),
// or the signed session cookie (browser WS handshakes cannot send an
// Authorization header). Note: this never trusts an inbound LOCAL_ORIGIN_HEADER
// — locality comes only from the socket + Host via isLocal, never a header.
export function decideProxyAuth(args: {
    req: Request;
    isLocal: boolean;
    provision: DashboardAuthProvision;
}): AuthDecision {
    const { req, isLocal, provision } = args;

    if (isLocal) {
        return "allow";
    }

    if (!provision.auth.enabled) {
        return "allow";
    }

    if (!isCompleteAuthConfig(provision.auth)) {
        return "unconfigured";
    }

    const auth: CompleteDashboardAuthConfig = provision.auth;

    if (
        verifyBasicAuthHeader(req.headers.get("authorization"), auth) ||
        verifySessionToken(req.headers.get("cookie"), auth)
    ) {
        return "allow";
    }

    return "deny";
}

async function authorizeProxied(req: Request, isLocal: boolean): Promise<AuthDecision> {
    return decideProxyAuth({ req, isLocal, provision: await getDashboardAuthCached() });
}

interface BridgeData {
    targetWsUrl: string;
    protocols: string[];
    out: WebSocket | null;
    queue: (string | Buffer<ArrayBuffer>)[];
    closed: boolean;
}

// In-process registry lookup (hydrated once) — no per-request disk I/O, since
// this runs for every /ttyd/<id>/* asset request, not just the WS upgrade.
const resolveTtydPort = getTtydPort;

function normalizeCloseCode(code: number): number {
    return code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
}

// Cap frames buffered before the upstream WS opens, so a flooding client
// can't grow the queue unbounded while the upstream is slow/stalled.
const MAX_WS_QUEUE = 256;

export function startFrontProxy(opts: { publicPort: number; internalPort: number }): Server<BridgeData> {
    const { publicPort, internalPort } = opts;
    const viteHttp = `http://127.0.0.1:${internalPort}`;
    const viteWs = `ws://127.0.0.1:${internalPort}`;

    const server = Bun.serve<BridgeData>({
        port: publicPort,
        hostname: "0.0.0.0",
        idleTimeout: 0,
        async fetch(req, srv) {
            const url = new URL(req.url);
            const ttyd = url.pathname.match(TTYD_PATH);
            const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
            const clientAddress = srv.requestIP(req)?.address;
            const isLocal = isLoopbackOnlyOrigin(req, clientAddress);

            // Plain Vite-forwarded HTTP stays gated by the Vite middleware
            // downstream; only the two paths that skip it (ttyd assets + any WS
            // upgrade) need an auth gate here.
            if (ttyd || isUpgrade) {
                const decision = await authorizeProxied(req, isLocal);

                if (decision === "unconfigured") {
                    return new Response("Dashboard auth is enabled but no password hash is configured.", {
                        status: 503,
                        headers: { "Content-Type": "text/plain; charset=utf-8" },
                    });
                }

                if (decision === "deny") {
                    return new Response("Authentication required.", {
                        status: 401,
                        headers: {
                            "WWW-Authenticate": WWW_AUTHENTICATE,
                            "Content-Type": "text/plain; charset=utf-8",
                        },
                    });
                }
            }

            let httpTarget: string;
            let wsTarget: string;

            if (ttyd) {
                const port = await resolveTtydPort(ttyd[1]);

                if (!port) {
                    return new Response("ttyd session not found", { status: 502 });
                }

                httpTarget = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
                wsTarget = `ws://127.0.0.1:${port}${url.pathname}${url.search}`;
            } else {
                httpTarget = `${viteHttp}${url.pathname}${url.search}`;
                wsTarget = `${viteWs}${url.pathname}${url.search}`;
            }

            if (isUpgrade) {
                const rawProtocol = req.headers.get("sec-websocket-protocol");
                const protocols = rawProtocol
                    ? rawProtocol
                          .split(",")
                          .map((p) => p.trim())
                          .filter(Boolean)
                    : [];
                const upgraded = srv.upgrade(req, {
                    data: { targetWsUrl: wsTarget, protocols, out: null, queue: [], closed: false },
                    headers: protocols.length > 0 ? { "Sec-WebSocket-Protocol": protocols[0] } : undefined,
                });

                if (upgraded) {
                    return undefined;
                }

                return new Response("WebSocket upgrade failed", { status: 426 });
            }

            // Strip any inbound x-dd-local-origin first (anti-spoof), then re-add
            // it only for a genuine loopback origin so the Vite auth middleware
            // can skip Basic Auth for localhost. Applied to the ttyd fetch too —
            // ttyd ignores it and the strip must cover every forwarded request.
            const forwarded = new Request(httpTarget, req);
            forwarded.headers.delete(LOCAL_ORIGIN_HEADER);

            if (isLocal) {
                forwarded.headers.set(LOCAL_ORIGIN_HEADER, "1");
            }

            let upstream: Response;

            try {
                upstream = await fetch(forwarded, {
                    redirect: "manual",
                    signal: AbortSignal.timeout(15_000),
                });
            } catch (err) {
                // A refused connection is almost always the benign startup race
                // (upstream Vite/ttyd not listening yet) — log it at debug so it
                // doesn't look like an error. A sustained real outage is still
                // visible (the 502 below) and any non-refused failure stays warn.
                const code = (err as { code?: string })?.code;
                const refused = code === "ConnectionRefused" || code === "ECONNREFUSED";
                logger[refused ? "debug" : "warn"]({ err, httpTarget }, "front proxy: upstream fetch failed");
                return new Response("Bad Gateway: upstream unavailable", { status: 502 });
            }

            // Bun's fetch transparently decodes the upstream body (ttyd gzips its
            // big inline bundle) but leaves Content-Encoding/Content-Length on the
            // headers. Relaying those verbatim makes the browser try to gunzip
            // already-plain bytes → ERR_CONTENT_DECODING_FAILED (blank iframe).
            // Cloudflare re-normalizes encoding in transit, which is why it only
            // reproduced on a direct localhost hit. Strip the now-stale headers.
            const headers = new Headers(upstream.headers);
            headers.delete("content-encoding");
            headers.delete("content-length");
            headers.delete("transfer-encoding");

            // new Headers() can fold multiple Set-Cookie into one; re-apply each
            // so the session cookie the Vite middleware issues survives the relay.
            const setCookies = upstream.headers.getSetCookie?.() ?? [];

            if (setCookies.length > 0) {
                headers.delete("set-cookie");

                for (const cookie of setCookies) {
                    headers.append("set-cookie", cookie);
                }
            }

            return new Response(upstream.body, {
                status: upstream.status,
                statusText: upstream.statusText,
                headers,
            });
        },
        websocket: {
            idleTimeout: 960,
            open(ws: ServerWebSocket<BridgeData>) {
                const data = ws.data;

                let out: WebSocket;

                try {
                    out =
                        data.protocols.length > 0
                            ? new WebSocket(data.targetWsUrl, data.protocols)
                            : new WebSocket(data.targetWsUrl);
                } catch (err) {
                    logger.warn({ err, target: data.targetWsUrl }, "front proxy: outbound WS construct failed");
                    data.closed = true;

                    try {
                        ws.close(1011);
                    } catch {
                        // client already gone
                    }

                    return;
                }

                out.binaryType = "arraybuffer";
                data.out = out;

                out.onopen = () => {
                    for (const queued of data.queue) {
                        out.send(queued);
                    }

                    data.queue = [];
                };

                out.onmessage = (event: MessageEvent) => {
                    if (data.closed) {
                        return;
                    }

                    try {
                        ws.send(event.data);
                    } catch {
                        // client closed between the check and the send
                    }
                };

                out.onclose = (event: CloseEvent) => {
                    data.closed = true;

                    try {
                        ws.close(normalizeCloseCode(event.code), event.reason);
                    } catch {
                        // client already gone
                    }
                };

                out.onerror = () => {
                    try {
                        ws.close(1011);
                    } catch {
                        // client already gone
                    }
                };
            },
            message(ws: ServerWebSocket<BridgeData>, message) {
                const out = ws.data.out;

                if (!out || out.readyState !== WebSocket.OPEN) {
                    if (ws.data.queue.length >= MAX_WS_QUEUE) {
                        // Upstream stalled while the client floods; cap memory.
                        ws.close(1013, "upstream not ready");
                        return;
                    }

                    ws.data.queue.push(message);
                    return;
                }

                try {
                    out.send(message);
                } catch {
                    // upstream closed between the readyState check and the send
                }
            },
            close(ws: ServerWebSocket<BridgeData>, code, reason) {
                const data = ws.data;
                data.closed = true;
                const out = data.out;

                if (out && (out.readyState === WebSocket.OPEN || out.readyState === WebSocket.CONNECTING)) {
                    try {
                        out.close(normalizeCloseCode(code), reason);
                    } catch {
                        // upstream already gone
                    }
                }
            },
        },
    });

    logger.info({ publicPort, internalPort }, "dev-dashboard front proxy started");

    return server;
}
