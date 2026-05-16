import { getConfig } from "@app/dev-dashboard/config";
import logger from "@app/logger";
import type { Server, ServerWebSocket } from "bun";

// Bun's node:http upgrade socket is a no-op (oven-sh/bun#28396 / PR #28347),
// so a Vite-middleware reverse proxy can't relay WebSockets. This front proxy
// runs on the public port using Bun's *native* server.upgrade (unaffected),
// forwards plain HTTP to the internal Vite server, serves /ttyd/<id>/* straight
// from the loopback ttyd session, and bridges every WebSocket (ttyd + Vite HMR)
// to its upstream frame-for-frame.

const TTYD_PATH = /^\/ttyd\/([0-9a-fA-F-]{36})(?:\/|$)/;

interface BridgeData {
    targetWsUrl: string;
    protocols: string[];
    out: WebSocket | null;
    queue: (string | Buffer<ArrayBuffer>)[];
    closed: boolean;
}

async function resolveTtydPort(id: string): Promise<number | null> {
    const config = await getConfig();
    const session = config.ttydSessions.find((s) => s.id === id);

    return session ? session.port : null;
}

function normalizeCloseCode(code: number): number {
    return code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
}

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

            if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
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

            let upstream: Response;

            try {
                upstream = await fetch(new Request(httpTarget, req), {
                    redirect: "manual",
                    signal: AbortSignal.timeout(15_000),
                });
            } catch (err) {
                logger.warn({ err, httpTarget }, "front proxy: upstream fetch failed");
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

                    ws.send(event.data);
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
                    ws.data.queue.push(message);
                    return;
                }

                out.send(message);
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
