import { clientProviderDenial, resolveClient } from "@app/ai-proxy/lib/clients";
import { acquireProvider, routeProviderKey } from "@app/ai-proxy/lib/providers/registry";
import type { ProxyProvider, RealtimeConnectTarget } from "@app/ai-proxy/lib/providers/types";
import { resolveModel } from "@app/ai-proxy/lib/resolve-model";
import type { AiProxyConfig, ResolvedRoute } from "@app/ai-proxy/lib/types";
import { scheduleBillingSync } from "@app/ai-proxy/lib/usage/billing-sync";
import { checkClientQuota } from "@app/ai-proxy/lib/usage/client-ledger";
import { recordUsageRequest } from "@app/ai-proxy/lib/usage/store";
import type { TokenUsage } from "@app/ai-proxy/lib/usage/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

// Transparent client↔upstream WebSocket tunnel for OpenAI-Realtime-compatible
// voice APIs (xAI grok-voice). The proxy only touches routing, auth, and
// logging — every frame (JSON events and binary audio alike) is relayed as-is.

/** Cap frames buffered before the upstream WS opens (audio floods fast). */
const MAX_WS_QUEUE = 1024;

export interface RealtimeBridgeData {
    target: RealtimeConnectTarget;
    client: string;
    route: ResolvedRoute;
    proxyModel: string;
    providers: Map<string, ProxyProvider>;
    upstream: WebSocket | null;
    queue: (string | Buffer<ArrayBuffer>)[];
    closed: boolean;
    startedAt: number;
    clientFrames: number;
    clientBytes: number;
    upstreamFrames: number;
    upstreamBytes: number;
    usage: TokenUsage | null;
}

function jsonError(status: number, message: string, extra?: { type?: string; code?: string }): Response {
    return new Response(SafeJSON.stringify({ error: { message, ...extra } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** Browsers cannot set WS headers — accept the proxy key via `?key=` too. */
function realtimeAuthRequest(req: Request, url: URL): Request {
    if (req.headers.get("Authorization")) {
        return req;
    }

    const key = url.searchParams.get("key");

    if (!key) {
        return req;
    }

    return new Request(req.url, { headers: { Authorization: `Bearer ${key}` } });
}

function normalizeCloseCode(code: number): number {
    return code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
}

function frameByteLength(payload: string | ArrayBuffer | Buffer): number {
    if (typeof payload === "string") {
        return Buffer.byteLength(payload, "utf8");
    }

    return payload.byteLength;
}

/**
 * Best-effort usage capture: OpenAI-Realtime upstreams report token usage on
 * `response.done` events (`response.usage.{input,output,total}_tokens`).
 * Accumulated per session and recorded on close; absent when upstream omits it.
 */
function sniffRealtimeUsage(data: RealtimeBridgeData, payload: string): void {
    if (!payload.includes('"response.done"')) {
        return;
    }

    try {
        const parsed = SafeJSON.parse(payload) as {
            type?: string;
            response?: { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
        };

        if (parsed.type !== "response.done") {
            return;
        }

        const usage = parsed.response?.usage;

        if (!usage || typeof usage !== "object") {
            return;
        }

        const prompt = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const completion = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        const total = typeof usage.total_tokens === "number" ? usage.total_tokens : prompt + completion;
        const acc = data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        acc.prompt_tokens = (acc.prompt_tokens ?? 0) + prompt;
        acc.completion_tokens = (acc.completion_tokens ?? 0) + completion;
        acc.total_tokens = (acc.total_tokens ?? 0) + total;
        data.usage = acc;
    } catch {
        // not JSON — an upstream is free to send arbitrary text frames
    }
}

/**
 * GET /v1/realtime?model=<proxy model id> — authenticated WS upgrade that
 * resolves the model to an account exactly like the chat path, then tunnels to
 * the provider's realtime endpoint. Returns undefined once upgraded.
 */
export async function handleRealtimeUpgrade(input: {
    req: Request;
    url: URL;
    server: Server<RealtimeBridgeData>;
    config: AiProxyConfig;
    providers: Map<string, ProxyProvider>;
}): Promise<Response | undefined> {
    const client = resolveClient(realtimeAuthRequest(input.req, input.url), input.config);

    if (!client) {
        return jsonError(401, "Invalid proxy API key", { type: "auth_error" });
    }

    const proxyModel = input.url.searchParams.get("model");

    if (!proxyModel) {
        return jsonError(400, "Missing model query param");
    }

    let route: ResolvedRoute;
    try {
        route = resolveModel(proxyModel, input.config.accounts);
    } catch (err) {
        return jsonError(400, err instanceof Error ? err.message : String(err));
    }

    const denial = clientProviderDenial(client, route.account.provider);

    if (denial) {
        logger.warn({ client: client.name, model: proxyModel, denial }, "ai-proxy: realtime provider denied");
        return jsonError(403, denial, { type: "forbidden", code: "provider_not_allowed" });
    }

    const quota = checkClientQuota(client);

    if (!quota.ok) {
        logger.warn({ client: client.name, reason: quota.reason }, "ai-proxy: realtime quota exceeded");
        return jsonError(429, quota.reason, { type: "quota_exceeded", code: "monthly_quota_exceeded" });
    }

    const provider = await acquireProvider(input.providers, route);

    if (!provider) {
        return jsonError(500, `Provider not loaded: ${routeProviderKey(route)}`);
    }

    if (typeof provider.realtimeConnect !== "function") {
        return jsonError(400, `Provider "${route.account.provider}" does not support realtime`);
    }

    const data: RealtimeBridgeData = {
        target: provider.realtimeConnect(route.upstreamId),
        client: client.name,
        route,
        proxyModel,
        providers: input.providers,
        upstream: null,
        queue: [],
        closed: false,
        startedAt: performance.now(),
        clientFrames: 0,
        clientBytes: 0,
        upstreamFrames: 0,
        upstreamBytes: 0,
        usage: null,
    };

    if (input.server.upgrade(input.req, { data })) {
        return undefined;
    }

    return jsonError(426, "WebSocket upgrade failed");
}

export const realtimeWebsocket: WebSocketHandler<RealtimeBridgeData> = {
    idleTimeout: 240,
    open(ws: ServerWebSocket<RealtimeBridgeData>) {
        const data = ws.data;

        let upstream: WebSocket;
        try {
            // Bun extension: headers on the client WebSocket constructor.
            upstream = new WebSocket(data.target.url, { headers: data.target.headers } as never);
        } catch (err) {
            logger.warn({ err, model: data.proxyModel }, "ai-proxy: realtime upstream WS construct failed");
            data.closed = true;

            try {
                ws.close(1011);
            } catch {
                // client already gone
            }

            return;
        }

        upstream.binaryType = "arraybuffer";
        data.upstream = upstream;

        logger.info(
            {
                model: data.proxyModel,
                upstreamModel: data.route.upstreamId,
                account: data.route.accountName,
                client: data.client,
            },
            "ai-proxy: realtime session open"
        );

        upstream.onopen = () => {
            for (const queued of data.queue) {
                upstream.send(queued);
            }

            data.queue = [];
        };

        upstream.onmessage = (event: MessageEvent) => {
            if (data.closed) {
                return;
            }

            const payload = event.data as string | ArrayBuffer;
            data.upstreamFrames += 1;
            data.upstreamBytes += frameByteLength(payload);

            if (typeof payload === "string") {
                sniffRealtimeUsage(data, payload);
            }

            try {
                ws.send(payload);
            } catch {
                // client closed between the check and the send
            }
        };

        upstream.onclose = (event: CloseEvent) => {
            data.closed = true;

            try {
                ws.close(normalizeCloseCode(event.code), event.reason);
            } catch {
                // client already gone
            }
        };

        upstream.onerror = () => {
            logger.warn({ model: data.proxyModel, target: data.target.url }, "ai-proxy: realtime upstream WS error");

            try {
                ws.close(1011);
            } catch {
                // client already gone
            }
        };
    },
    message(ws: ServerWebSocket<RealtimeBridgeData>, message) {
        const data = ws.data;
        data.clientFrames += 1;
        data.clientBytes += frameByteLength(message);
        const upstream = data.upstream;

        if (!upstream || upstream.readyState !== WebSocket.OPEN) {
            if (data.queue.length >= MAX_WS_QUEUE) {
                // Upstream stalled while the client floods; cap memory.
                ws.close(1013, "upstream not ready");
                return;
            }

            data.queue.push(message);
            return;
        }

        try {
            upstream.send(message);
        } catch {
            // upstream closed between the readyState check and the send
        }
    },
    close(ws: ServerWebSocket<RealtimeBridgeData>, code, _reason) {
        const data = ws.data;
        data.closed = true;
        const upstream = data.upstream;

        if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
            try {
                upstream.close(normalizeCloseCode(code), _reason);
            } catch {
                // upstream already gone
            }
        }

        const elapsedMs = Math.round(performance.now() - data.startedAt);

        logger.info(
            {
                model: data.proxyModel,
                upstreamModel: data.route.upstreamId,
                account: data.route.accountName,
                client: data.client,
                code,
                elapsedMs,
                clientFrames: data.clientFrames,
                clientBytes: data.clientBytes,
                upstreamFrames: data.upstreamFrames,
                upstreamBytes: data.upstreamBytes,
                usage: data.usage ?? undefined,
            },
            "ai-proxy: realtime session closed"
        );

        recordUsageRequest({
            ts: new Date().toISOString(),
            account: data.route.accountName,
            client: data.client,
            provider: data.route.account.provider,
            proxyModel: data.proxyModel,
            upstreamModel: data.route.upstreamId,
            path: "/v1/realtime",
            status: 101,
            elapsedMs,
            stream: true,
            usage: data.usage ?? undefined,
        });
        scheduleBillingSync(data.route.account, data.providers);
    },
};

/**
 * POST /v1/realtime/client_secrets — ephemeral-token mint pass-through. The
 * browser gets a short-lived upstream secret without ever seeing the account
 * API key; note the minted secret is used to talk to the upstream DIRECTLY
 * (the session itself bypasses the proxy — use the WS tunnel for full logging).
 */
export async function handleRealtimeClientSecrets(input: {
    req: Request;
    config: AiProxyConfig;
    providers: Map<string, ProxyProvider>;
}): Promise<Response> {
    const client = resolveClient(input.req, input.config);

    if (!client) {
        return jsonError(401, "Invalid proxy API key", { type: "auth_error" });
    }

    const bodyText = await input.req.text();

    let parsed: { model?: string; session?: { model?: string } };
    try {
        parsed = SafeJSON.parse(bodyText, { strict: true }) as { model?: string; session?: { model?: string } };
    } catch {
        return jsonError(400, "Invalid JSON body");
    }

    const proxyModel = parsed.session?.model ?? parsed.model;

    if (!proxyModel || typeof proxyModel !== "string") {
        return jsonError(400, "Missing model (set session.model)");
    }

    let route: ResolvedRoute;
    try {
        route = resolveModel(proxyModel, input.config.accounts);
    } catch (err) {
        return jsonError(400, err instanceof Error ? err.message : String(err));
    }

    const denial = clientProviderDenial(client, route.account.provider);

    if (denial) {
        logger.warn({ client: client.name, model: proxyModel, denial }, "ai-proxy: realtime provider denied");
        return jsonError(403, denial, { type: "forbidden", code: "provider_not_allowed" });
    }

    const quota = checkClientQuota(client);

    if (!quota.ok) {
        logger.warn({ client: client.name, reason: quota.reason }, "ai-proxy: realtime quota exceeded");
        return jsonError(429, quota.reason, { type: "quota_exceeded", code: "monthly_quota_exceeded" });
    }

    const provider = await acquireProvider(input.providers, route);

    if (!provider) {
        return jsonError(500, `Provider not loaded: ${routeProviderKey(route)}`);
    }

    if (typeof provider.realtimeClientSecrets !== "function") {
        return jsonError(400, `Provider "${route.account.provider}" does not support realtime client secrets`);
    }

    const started = performance.now();
    const response = await provider.realtimeClientSecrets(input.req, route.upstreamId, bodyText);

    logger.info(
        {
            path: "/v1/realtime/client_secrets",
            model: proxyModel,
            upstreamModel: route.upstreamId,
            status: response.status,
            elapsedMs: Math.round(performance.now() - started),
            client: client.name,
        },
        "ai-proxy: request"
    );

    return response;
}
