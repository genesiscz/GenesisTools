import { type DashboardAuthProvision, getDashboardAuthCached } from "@app/dev-dashboard/config";
import {
    type CompleteDashboardAuthConfig,
    isCompleteAuthConfig,
    LOCAL_ORIGIN_HEADER,
    verifyBasicAuthHeader,
    verifySessionToken,
} from "@app/dev-dashboard/lib/auth";
import { getTtydPort } from "@app/dev-dashboard/lib/ttyd/manager";
import { injectTtydMobileShell, shouldInjectTtydMobileShell } from "@app/dev-dashboard/lib/ttyd/mobile-shell";
// Leaf imports on purpose: the preview barrel pulls in Vite, which has no place
// in the request path of the public proxy.
import { RELOAD_PATH as PREVIEW_RELOAD_PATH } from "@genesiscz/utils/DashboardApp/preview/reload";
import { isPreviewRestarting } from "@genesiscz/utils/DashboardApp/preview/restartState";
import { logger } from "@genesiscz/utils/logger";
import type { Server, ServerWebSocket } from "bun";

// Bun's node:http upgrade socket is a no-op (oven-sh/bun#28396 / PR #28347),
// so a Vite-middleware reverse proxy can't relay WebSockets. This front proxy
// runs on the public port using Bun's *native* server.upgrade (unaffected),
// forwards plain HTTP to the internal Vite server, serves /ttyd/<id>/* straight
// from the loopback ttyd session, and bridges every WebSocket (ttyd + Vite HMR)
// to its upstream frame-for-frame.

const TTYD_PATH = /^\/ttyd\/([0-9a-fA-F-]{36})(?:\/|$)/;

/**
 * SSE and other streaming routes must not use the short upstream fetch timeout.
 *
 * Every `longLived: true` route in the dashboard router belongs here, plus the
 * preview reload stream, which is not a router route. `front-proxy.test.ts`
 * derives the router's list and fails when one is missing: while
 * /api/daemon/runs/tail and /__preview_reload were absent, AbortSignal.timeout
 * tore their bodies down every 15 s mid-stream.
 */
export function isLongLivedProxiedStream(pathname: string): boolean {
    if (
        pathname === "/api/qa/stream" ||
        pathname === "/api/boards/work/wait" ||
        pathname === "/api/ports/classify" ||
        pathname === "/api/daemon/runs/tail" ||
        pathname === "/api/live" ||
        pathname === PREVIEW_RELOAD_PATH
    ) {
        return true;
    }
    return pathname.startsWith("/api/boards/") && pathname.endsWith("/events");
}

/** Default bound for a plain proxied request. */
export const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Bound for APIs that legitimately run long: /api/ports rescans and probes every
 * listener, and the macOS pulse endpoints read system counters. They are not
 * streams, so they keep a timeout — just one they can actually finish inside.
 * Measured from `dev-dashboard.bg.log`: 36 TimeoutError on /api/ports, 22 on the
 * pulse pair, 1 on /api/tmux/sessions, every one of them a public 502.
 */
export const SLOW_UPSTREAM_TIMEOUT_MS = 60_000;

const SLOW_UPSTREAM_PATHS = new Set([
    "/api/ports",
    "/api/system/pulse",
    "/api/system/pulse/history",
    "/api/tmux/sessions",
]);

/**
 * Bound for the recorded-spend routes, which rebuild cost by walking every
 * coding-agent transcript on disk. A cold 30-day scan measures about 20s and a
 * cold 7-day one about 4s, and the answer is cached for 15s afterwards. Under
 * the 15s default the cold scan was killed at exactly 15.0s and the browser got
 * a 502 `upstream-timeout`; only a retry that landed inside the cache succeeded
 * (sweep 2026-09-04). The work is off the request thread now, so a long wait
 * here costs this one request and nothing else.
 */
export const SCAN_UPSTREAM_TIMEOUT_MS = 120_000;

const SCAN_UPSTREAM_PATHS = new Set([
    "/api/ai/spend/totals",
    "/api/ai/spend/series",
    // The legacy alias reaches the same handler.
    "/api/claude/usage/totals",
]);

/** Upstream fetch deadline for a path. `undefined` means no deadline (a stream). */
export function upstreamTimeoutMs(pathname: string): number | undefined {
    if (isLongLivedProxiedStream(pathname)) {
        return undefined;
    }

    if (SCAN_UPSTREAM_PATHS.has(pathname)) {
        return SCAN_UPSTREAM_TIMEOUT_MS;
    }

    if (SLOW_UPSTREAM_PATHS.has(pathname)) {
        return SLOW_UPSTREAM_TIMEOUT_MS;
    }

    return UPSTREAM_TIMEOUT_MS;
}

const UPSTREAM_RETRY_ATTEMPTS = 10;
const UPSTREAM_RETRY_MS = 250;

/**
 * Methods a 502/503/504 RESPONSE may be replayed for.
 *
 * A response means the request reached a handler, so a replay re-runs whatever
 * that handler already did. A POST/PATCH/DELETE that mutated state and then
 * answered 503 was executed up to ten times. Only methods with no side effect
 * of their own are replayed here. PUT and DELETE are idempotent on paper, but
 * this proxy fronts arbitrary dashboard routes, so they stay out.
 *
 * A refused connection is different: nothing reached a handler, so THAT retry
 * stays on for every method (it is the make-before-break preview swap).
 */
const RESPONSE_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isResponseRetryableMethod(method: string): boolean {
    return RESPONSE_RETRY_METHODS.has(method.toUpperCase());
}

/**
 * How much of a request body the proxy holds in memory so a refused attempt can
 * be replayed. A body that fits is buffered and stays retryable; a bigger one
 * streams through with the retries switched off. Buffering unconditionally
 * turned a 500 MB upload into a 500 MB allocation, and made the upstream wait
 * for the whole upload before it saw a single byte.
 */
const MAX_REPLAYABLE_BODY_BYTES = 8 * 1024 * 1024;

/** `duplex: "half"` is required to send a streaming body; the DOM lib types omit it. */
type StreamingRequestInit = RequestInit & { duplex?: "half" };

interface PreparedBody {
    body: ArrayBuffer | ReadableStream<Uint8Array> | undefined;
    /** False once the body is a stream: sending it consumes it, so one attempt only. */
    replayable: boolean;
}

/** Emits what was already read, then hands the rest of the client's stream through. */
function streamRemainder(
    buffered: Uint8Array[],
    reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const next = buffered.shift();

            if (next) {
                controller.enqueue(next);

                return;
            }

            const { done, value } = await reader.read();

            if (done) {
                controller.close();

                return;
            }

            controller.enqueue(value);
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

/**
 * Read the body up to the cap. Content-Length is not consulted: a chunked
 * upload carries none, and neither does a Request built in a test.
 */
async function prepareUpstreamBody(request: Request): Promise<PreparedBody> {
    if (request.body === null) {
        return { body: undefined, replayable: true };
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    while (size <= MAX_REPLAYABLE_BODY_BYTES) {
        const { done, value } = await reader.read();

        if (done) {
            const buffer = new Uint8Array(size);
            let offset = 0;

            for (const chunk of chunks) {
                buffer.set(chunk, offset);
                offset += chunk.byteLength;
            }

            return { body: buffer.buffer, replayable: true };
        }

        chunks.push(value);
        size += value.byteLength;
    }

    return { body: streamRemainder(chunks, reader), replayable: false };
}

function isConnectionRefused(err: unknown): boolean {
    const code = (err as { code?: string })?.code;
    return code === "ConnectionRefused" || code === "ECONNREFUSED";
}

export class UpstreamRetriesExhausted extends Error {
    constructor(readonly attempts: number) {
        super(`fetchProxiedUpstream exhausted ${attempts} attempts without a response`);
        this.name = "UpstreamRetriesExhausted";
    }
}

/** Filled in by `fetchProxiedUpstream` so a 502 log line can state the retry count. */
export interface UpstreamAttemptStats {
    attempts: number;
}

export type ProxyFailureReason =
    | "client-abort"
    | "upstream-timeout"
    | "upstream-refused"
    | "retries-exhausted"
    | "upstream-error"
    | "ttyd-missing";

/**
 * Name the 502 so the log can be counted by cause. `TimeoutError` must be tested
 * before `AbortError`: both are DOMExceptions, and an upstream that blew the
 * deadline is a server fault while a client closing its tab is not.
 */
export function classifyUpstreamFailure(err: unknown): ProxyFailureReason {
    if (err instanceof UpstreamRetriesExhausted) {
        return "retries-exhausted";
    }

    if (isConnectionRefused(err)) {
        return "upstream-refused";
    }

    const name = (err as { name?: string })?.name;

    if (name === "TimeoutError") {
        return "upstream-timeout";
    }

    if (name === "AbortError") {
        return "client-abort";
    }

    return "upstream-error";
}

/** A refused upstream is the benign startup race; a client abort is a closed tab. */
export function proxyFailureLogLevel(reason: ProxyFailureReason): "debug" | "warn" {
    return reason === "upstream-refused" || reason === "client-abort" ? "debug" : "warn";
}

function logProxyGatewayError(args: {
    reason: ProxyFailureReason;
    httpTarget: string;
    err?: unknown;
    attempts?: number;
    timeoutMs?: number;
}): void {
    const { reason, httpTarget, err, attempts, timeoutMs } = args;

    logger[proxyFailureLogLevel(reason)](
        {
            reason,
            httpTarget,
            attempts,
            timeoutMs,
            errName: (err as { name?: string })?.name,
            errCode: (err as { code?: string | number })?.code,
            previewRestarting: isPreviewRestarting(),
            err,
        },
        "front proxy: returning 502"
    );
}

export async function fetchProxiedUpstream(
    forwarded: Request,
    timeoutMs: number | undefined,
    stats: UpstreamAttemptStats = { attempts: 0 }
): Promise<Response> {
    // Retrying the SAME Request object throws `ERR_BODY_ALREADY_USED` on attempt
    // 2, and that is not a ConnectionRefused, so every request WITH a body got
    // one attempt and an immediate 502 blaming `upstream-error`. Buffer the body
    // once and rebuild the request per attempt — but only up to
    // MAX_REPLAYABLE_BODY_BYTES.
    const target = forwarded.url;
    const method = forwarded.method;
    const headers = forwarded.headers;
    const clientSignal = forwarded.signal;
    const { body, replayable } = await prepareUpstreamBody(forwarded);
    const replayResponses = isResponseRetryableMethod(method) && replayable;

    if (!replayable) {
        logger.debug(
            { httpTarget: target, method },
            "front proxy: body over the buffer cap, streaming without retries"
        );
    }

    for (let attempt = 0; attempt < UPSTREAM_RETRY_ATTEMPTS; attempt++) {
        stats.attempts = attempt + 1;

        try {
            // AbortSignal.timeout alone REPLACED the client's own signal, so a
            // closed tab left the upstream work running for the whole deadline —
            // five reloads of the ports page stacked five 60 s rescans.
            const signal =
                timeoutMs === undefined
                    ? clientSignal
                    : AbortSignal.any([clientSignal, AbortSignal.timeout(timeoutMs)]);
            const init: StreamingRequestInit = {
                method,
                headers,
                ...(body === undefined ? {} : { body }),
                redirect: "manual",
                signal,
            };

            if (body instanceof ReadableStream) {
                // Required to send a streaming body; the DOM lib types omit it.
                init.duplex = "half";
            }

            const upstream = await fetch(target, init);

            if (
                replayResponses &&
                (upstream.status === 502 || upstream.status === 503 || upstream.status === 504) &&
                attempt < UPSTREAM_RETRY_ATTEMPTS - 1
            ) {
                // Discarding a response without reading it keeps its socket
                // checked out of the pool until GC: up to nine leaked streams
                // per request during a preview restart storm.
                await upstream.body?.cancel().catch((cancelError) => {
                    logger.debug({ cancelError, httpTarget: target }, "front proxy: discarded body cancel failed");
                });
                await Bun.sleep(UPSTREAM_RETRY_MS);
                continue;
            }

            return upstream;
        } catch (err) {
            if (isConnectionRefused(err) && replayable && attempt < UPSTREAM_RETRY_ATTEMPTS - 1) {
                await Bun.sleep(UPSTREAM_RETRY_MS);
                continue;
            }

            throw err;
        }
    }

    throw new UpstreamRetriesExhausted(stats.attempts);
}

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

export function startFrontProxy(opts: {
    publicPort: number;
    /**
     * A function when the preview can swap upstreams under the proxy
     * (make-before-break restart) — read per request, never captured.
     */
    internalPort: number | (() => number);
    hostname?: string;
}): Server<BridgeData> {
    const { publicPort } = opts;
    const port = opts.internalPort;
    const resolveInternalPort = typeof port === "function" ? port : () => port;
    const hostname = opts.hostname ?? "0.0.0.0";

    const server = Bun.serve<BridgeData>({
        port: publicPort,
        hostname,
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
                const ttydPort = await resolveTtydPort(ttyd[1]);

                if (!ttydPort) {
                    logProxyGatewayError({
                        reason: "ttyd-missing",
                        httpTarget: `${url.pathname}${url.search}`,
                    });

                    return new Response("ttyd session not found", { status: 502 });
                }

                httpTarget = `http://127.0.0.1:${ttydPort}${url.pathname}${url.search}`;
                wsTarget = `ws://127.0.0.1:${ttydPort}${url.pathname}${url.search}`;
            } else {
                const internalPort = resolveInternalPort();
                httpTarget = `http://127.0.0.1:${internalPort}${url.pathname}${url.search}`;
                wsTarget = `ws://127.0.0.1:${internalPort}${url.pathname}${url.search}`;
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
            const timeoutMs = upstreamTimeoutMs(url.pathname);
            const stats: UpstreamAttemptStats = { attempts: 0 };

            try {
                upstream = await fetchProxiedUpstream(forwarded, timeoutMs, stats);
            } catch (err) {
                const reason = classifyUpstreamFailure(err);
                logProxyGatewayError({ reason, httpTarget, err, attempts: stats.attempts, timeoutMs });

                return new Response(`Bad Gateway: upstream unavailable (${reason})`, { status: 502 });
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

            if (ttyd && shouldInjectTtydMobileShell(url.pathname, headers.get("content-type"))) {
                const html = await upstream.text();

                return new Response(injectTtydMobileShell(html), {
                    status: upstream.status,
                    statusText: upstream.statusText,
                    headers,
                });
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

    logger.info({ publicPort, internalPort: resolveInternalPort() }, "dev-dashboard front proxy started");

    return server;
}
