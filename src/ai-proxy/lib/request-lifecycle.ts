import { resolveProxyRoute } from "@app/ai-proxy/lib/account-model-ref";
import { type ResolvedClient, resolveClient, routeDenial } from "@app/ai-proxy/lib/clients";
import { jsonError } from "@app/ai-proxy/lib/http-error";
import { acquireProvider, providerUnavailableResponse } from "@app/ai-proxy/lib/providers/pool";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { findInvalidImageDataPayload } from "@app/ai-proxy/lib/rewrite-upstream-body";
import { recordCompactionEvent } from "@app/ai-proxy/lib/sessions/compaction-events";
import { type AiProxySessionRecord, noteSessionRequest } from "@app/ai-proxy/lib/sessions/records";
import { resolveSessionRoute, sessionPinnedRoute } from "@app/ai-proxy/lib/sessions/routing";
import { requestTagsFor } from "@app/ai-proxy/lib/sessions/tags";
import { ClaudeCodeTurn } from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import type { AiProxyConfig, EffortSource, ResolvedRoute } from "@app/ai-proxy/lib/types";
import { scheduleBillingSync } from "@app/ai-proxy/lib/usage/billing-sync";
import type { CallTimeline } from "@app/ai-proxy/lib/usage/call-timeline";
import { checkClientQuota } from "@app/ai-proxy/lib/usage/client-ledger";
import type { PrefixDiff } from "@app/ai-proxy/lib/usage/prefix-diff";
import { scheduleUsageTracking } from "@app/ai-proxy/lib/usage/track-response";
import type { RequestTags } from "@app/ai-proxy/lib/usage/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/**
 * One request lifecycle for the three model doors (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`). A door
 * supplies its error envelope, its body parse and its pipeline call; `serveModelDoor` owns the steps every door
 * shares, in this order: client resolution, the 401, the body read, the session note, the gate, tracking, the
 * request log and the error envelope. Realtime and audio share only the gate (`gateModelRoute`).
 */

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** The OpenAI `type` and `code` of an error. Anthropic's envelope derives its type from the status instead. */
export interface DoorErrorDetail {
    type?: string;
    code?: string;
}

/** A door's error body. Every error a door answers goes through it, so a client always reads its own protocol. */
export type DoorEnvelope = (status: number, message: string, detail?: DoorErrorDetail) => Response;

export const openAiEnvelope: DoorEnvelope = (status, message, detail) => jsonError(status, message, detail);

/** Claude Code reads `type: "error"` first and showed an OpenAI-shaped body as a blank failure. */
const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    429: "rate_limit_error",
};

export const anthropicEnvelope: DoorEnvelope = (status, message) =>
    new Response(
        SafeJSON.stringify({ type: "error", error: { type: ANTHROPIC_ERROR_TYPES[status] ?? "api_error", message } }),
        { status, headers: { "Content-Type": "application/json" } }
    );

/** A request the door refuses before any upstream runs: a body it cannot read, or the gate's answer. */
export class DoorRequestError extends Error {
    readonly status: number;
    readonly detail?: DoorErrorDetail;

    constructor(status: number, message: string, detail?: DoorErrorDetail) {
        super(message);
        this.name = "DoorRequestError";
        this.status = status;
        this.detail = detail;
    }
}

/** What the lifecycle reads from every door's body: the model, and the ids that tag the request. */
export interface DoorBody {
    model: string;
    /** The session id Claude Code put in `metadata.user_id`. */
    claudeSessionId?: string;
    /** The conversation id the client sent on its own: Claude Code's session id, else a body `prompt_cache_key`. */
    conversationId?: string;
}

/** The body fields of a model request. Shared by the three doors, so a guard added for one is never missing from another. */
export interface ModelRequestBody extends DoorBody {
    /** Claude Code's compaction turn (`/v1/messages`). */
    compaction: boolean;
    /** Claude Code's one-token `model_validation` probe (`/v1/messages`). */
    probe: boolean;
    stream: boolean;
    /** The effort the client set itself: Claude Code's `/effort`, sent as `output_config.effort`. */
    clientEffort?: string;
}

/** The exchange the upstream saw, as the door reports it: the lifecycle books it and logs the request once. */
export interface DoorExchange {
    /** The body the upstream received (after translation and the effort stamp). */
    upstreamBody: string;
    /** The client's own bytes for the transcript. */
    clientRequestBody: string;
    responseBody: Promise<string>;
    clientResponseBody?: Promise<string>;
    timeline?: Promise<CallTimeline>;
    captureFailure?: Promise<string | undefined>;
    translate: string;
    thinking?: string;
    cacheKey?: string;
    compaction?: boolean;
    effort?: string;
    effortSource?: EffortSource;
    prefix?: PrefixDiff;
    /** Door-specific fields of the `ai-proxy: request` log line. */
    logFields?: Record<string, unknown>;
}

export interface DoorContext<Body> {
    req: Request;
    /** The normalized request path. */
    path: string;
    config: AiProxyConfig;
    body: Body;
    bodyText: string;
    client: ResolvedClient;
    session?: AiProxySessionRecord;
    tags?: RequestTags;
    route: ResolvedRoute;
    provider: ProxyProvider;
    startedAt: number;
    /** Report the upstream exchange. A reply the door answers itself (Claude Code's probe) reports none. */
    record: (exchange: DoorExchange) => void;
}

export interface ModelDoor<Body extends DoorBody> {
    name: "messages" | "chat" | "responses";
    /** The error body shape of this door's protocol. */
    envelope: DoorEnvelope;
    /** The door's body from the parsed JSON. Throws `DoorRequestError` for a body it refuses. */
    parse: (raw: unknown) => Body;
    run: (context: DoorContext<Body>) => Promise<Response>;
}

export interface LifecycleDeps {
    config: AiProxyConfig;
    providers: Map<string, ProxyProvider>;
    /** The normalized request path, for the request log and the usage record. */
    path: string;
}

/** The model, the image guard and Claude Code's turn facts, read once for every door. */
export function parseModelBody(raw: unknown): ModelRequestBody {
    const parsed = isObject(raw) ? raw : {};

    if (typeof parsed.model !== "string" || !parsed.model) {
        throw new DoorRequestError(400, "Missing model");
    }

    const model = parsed.model;
    const invalidImagePayload = findInvalidImageDataPayload(parsed);

    if (invalidImagePayload !== null) {
        logger.warn(
            { model, payloadPreview: invalidImagePayload },
            "ai-proxy: rejecting image content with invalid base64 payload"
        );

        throw new DoorRequestError(
            400,
            `Image content part carries an invalid base64 payload (${SafeJSON.stringify(invalidImagePayload)}) — ` +
                "the image bytes never reached the proxy. This usually means the client stringified an object " +
                'into the data URL (e.g. AI SDK v2-compat file parts becoming "[object Object]").',
            { type: "invalid_request_error", code: "invalid_image_data" }
        );
    }

    const turn = ClaudeCodeTurn.read(parsed);
    const claudeSessionId = turn.sessionId;
    const cacheKey = typeof parsed.prompt_cache_key === "string" ? parsed.prompt_cache_key.trim() : "";

    if (turn.missedCompaction) {
        recordCompactionEvent({
            kind: "missed",
            ...(claudeSessionId ? { claudeSession: claudeSessionId } : {}),
            model,
            reason: "the request carries Claude Code's compaction prompt, but it was not read as a compaction turn",
        });
    }

    return {
        model,
        claudeSessionId,
        conversationId: claudeSessionId ?? (cacheKey || undefined),
        compaction: turn.isCompaction,
        probe: turn.isModelProbe,
        stream: turn.stream,
        clientEffort: turn.effort,
    };
}

/** The answer to a request whose body stream failed before it ended: the client's side broke, so it is a 400. */
export const BODY_UNREADABLE_MESSAGE = "Could not read the request body";

/** A request body stream that failed while it was read (the client hung up, or its stream errored). */
export class BodyReadError extends Error {
    constructor(cause: unknown) {
        super(BODY_UNREADABLE_MESSAGE, { cause });
        this.name = "BodyReadError";
    }
}

/** The request body as text; a stream that fails throws `BodyReadError`, which the error mapper answers as a 400. */
export async function readRequestText(req: Request): Promise<string> {
    try {
        return await req.text();
    } catch (err) {
        throw new BodyReadError(err);
    }
}

/** Read a model-bearing POST body once, with the size guard, and hand the parsed JSON to the door. */
async function readDoorBody<Body extends DoorBody>(
    req: Request,
    door: ModelDoor<Body>
): Promise<{ bodyText: string; body: Body }> {
    const contentLength = req.headers.get("content-length");

    if (contentLength) {
        const declaredBytes = Number.parseInt(contentLength, 10);

        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BODY_BYTES) {
            throw new DoorRequestError(413, "Request body too large");
        }
    }

    const bodyText = await readRequestText(req);

    if (Buffer.byteLength(bodyText, "utf8") > MAX_REQUEST_BODY_BYTES) {
        throw new DoorRequestError(413, "Request body too large");
    }

    let raw: unknown;

    try {
        raw = SafeJSON.parse(bodyText, { strict: true });
    } catch (err) {
        logger.debug({ err }, "ai-proxy: invalid JSON body");
        throw new DoorRequestError(400, "Invalid JSON body");
    }

    return { bodyText, body: door.parse(raw) };
}

/** Why the gate refused a route, in protocol-neutral terms; each door renders it with its own envelope. */
export interface GateRefusal {
    status: number;
    message: string;
    detail?: DoorErrorDetail;
    headers?: Record<string, string>;
}

export type GateResult = { route: ResolvedRoute; provider: ProxyProvider } | { refusal: GateRefusal };

/** A gate refusal as a door's error response. */
export function refusalResponse(envelope: DoorEnvelope, refusal: GateRefusal): Response {
    const response = envelope(refusal.status, refusal.message, refusal.detail);

    for (const [name, value] of Object.entries(refusal.headers ?? {})) {
        response.headers.set(name, value);
    }

    return response;
}

/**
 * The provider pool answers an account that never constructed with its own 503 body; the gate carries its message,
 * type, code and `retry-after` over so a door can answer it in its own envelope.
 */
async function providerUnavailableRefusal(route: ResolvedRoute): Promise<GateRefusal> {
    const response = providerUnavailableResponse(route);
    const body: unknown = await response.json();
    const error = isObject(body) && isObject(body.error) ? body.error : {};
    const retryAfter = response.headers.get("retry-after");

    return {
        status: response.status,
        message: typeof error.message === "string" ? error.message : "Provider not loaded",
        detail: {
            type: typeof error.type === "string" ? error.type : undefined,
            code: typeof error.code === "string" ? error.code : undefined,
        },
        ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
    };
}

/**
 * The one gate for every routed door (the three model doors, realtime and audio): the session's own model forms,
 * model → account route, the session pin, the per-client denial, the quota, and a live provider. A route that does
 * not resolve throws, so each caller keeps its own answer to a bad model id.
 */
export async function gateModelRoute(input: {
    client: ResolvedClient;
    config: AiProxyConfig;
    model: string;
    providers: Map<string, ProxyProvider>;
    /** Names the door in the refusal logs (`realtime`, `transcriptions`); the model doors log without one. */
    logLabel?: string;
}): Promise<GateResult> {
    const { client, config, model } = input;
    const label = input.logLabel ? `${input.logLabel} ` : "";
    const sessionRoute = client.session ? resolveSessionRoute(model, client.session, config.accounts) : undefined;

    if (sessionRoute && "refusal" in sessionRoute) {
        logger.warn(
            { client: client.name, model, refusal: sessionRoute.refusal },
            `ai-proxy: ${label}session route refused`
        );

        return {
            refusal: {
                status: 400,
                message: sessionRoute.refusal,
                detail: { type: "invalid_request_error", code: "model_not_in_session" },
            },
        };
    }

    const resolved = sessionRoute?.route ?? (await resolveProxyRoute(model, config.accounts));
    // A session reaches only the accounts its record names, also through a full account id: never their failover.
    const route = client.session ? sessionPinnedRoute(resolved) : resolved;
    const denial = routeDenial(client, route.account);

    if (denial) {
        logger.warn({ client: client.name, model, denial }, `ai-proxy: ${label}provider denied`);

        return {
            refusal: { status: 403, message: denial, detail: { type: "forbidden", code: "provider_not_allowed" } },
        };
    }

    const quota = checkClientQuota(client);

    if (!quota.ok) {
        logger.warn({ client: client.name, reason: quota.reason }, `ai-proxy: ${label}quota exceeded`);

        return {
            refusal: {
                status: 429,
                message: quota.reason,
                detail: { type: "quota_exceeded", code: "monthly_quota_exceeded" },
            },
        };
    }

    const provider = await acquireProvider(input.providers, route);

    if (!provider) {
        return { refusal: await providerUnavailableRefusal(route) };
    }

    return { route, provider };
}

/**
 * Logs a request that threw. When the client already hung up (Claude Code quit or was interrupted), the upstream
 * fetch fails with "The connection was closed": that is the client's choice, logged at debug as 499, not a 502
 * warning (on 2026-10-27 every resume of a ccx session left one in the warn log).
 */
export function logRequestFailure(input: {
    req: Request;
    err: unknown;
    status: number;
    fields: Record<string, unknown>;
}): void {
    if (input.req.signal.aborted) {
        logger.debug({ ...input.fields, status: 499, error: input.err }, "ai-proxy: the client closed the request");
        return;
    }

    logger.warn({ ...input.fields, status: input.status, error: input.err }, "ai-proxy: request failed");
}

/**
 * A model id that does not resolve and a body stream that failed are the client's side (400 with the reason); anything
 * else that threw is a 502.
 * A provider's expired login is not mapped here: each forward answers it itself through `exchange()` (http-relay.ts).
 */
function mapProxyRequestError(err: unknown): { status: number; message: string } {
    if (err instanceof BodyReadError) {
        return { status: 400, message: err.message };
    }

    const message = err instanceof Error ? err.message : String(err);

    if (
        message.startsWith("Model id must be") ||
        message.startsWith("No enabled account for model") ||
        message.startsWith("Ambiguous model")
    ) {
        return { status: 400, message };
    }

    return { status: 502, message: "Request failed" };
}

function trackExchange(input: {
    deps: LifecycleDeps;
    route: ResolvedRoute;
    client: string;
    proxyModel: string;
    status: number;
    elapsedMs: number;
    tags?: RequestTags;
    exchange: DoorExchange;
}): void {
    const { exchange } = input;

    scheduleUsageTracking({
        route: input.route,
        client: input.client,
        proxyModel: input.proxyModel,
        path: input.deps.path,
        status: input.status,
        elapsedMs: input.elapsedMs,
        bodyText: exchange.upstreamBody,
        responseBody: exchange.responseBody,
        clientRequestBody: exchange.clientRequestBody,
        clientResponseBody: exchange.clientResponseBody,
        timeline: exchange.timeline,
        captureFailure: exchange.captureFailure,
        translate: exchange.translate,
        thinking: exchange.thinking,
        tags: input.tags,
        cacheKey: exchange.cacheKey,
        compaction: exchange.compaction,
        effort: exchange.effort,
        effortSource: exchange.effortSource,
        prefix: exchange.prefix,
    });
    scheduleBillingSync(input.route.account, input.deps.providers);
}

/** What the error mapper logs for a request that failed: when it started, and its model once the body named one. */
interface DoorRequestFacts {
    startedAt: number;
    model?: string;
}

/**
 * Serve one model request through a door. Every error the request meets answers in the door's envelope, from the
 * client resolution and the body read on: a refusal with its own status, a client that hung up as a 499 in the log, and
 * anything else through the error mapper.
 */
export async function serveModelDoor<Body extends DoorBody>(
    request: Request,
    door: ModelDoor<Body>,
    deps: LifecycleDeps
): Promise<Response> {
    const facts: DoorRequestFacts = { startedAt: performance.now() };

    try {
        return await runModelDoor({ request, door, deps, facts });
    } catch (err) {
        if (err instanceof DoorRequestError) {
            return door.envelope(err.status, err.message, err.detail);
        }

        const mapped = mapProxyRequestError(err);
        logRequestFailure({
            req: request,
            err,
            status: mapped.status,
            fields: {
                path: deps.path,
                model: facts.model,
                elapsedMs: Math.round(performance.now() - facts.startedAt),
            },
        });

        return door.envelope(mapped.status, mapped.message);
    }
}

async function runModelDoor<Body extends DoorBody>(input: {
    request: Request;
    door: ModelDoor<Body>;
    deps: LifecycleDeps;
    facts: DoorRequestFacts;
}): Promise<Response> {
    const { request, door, deps, facts } = input;
    const client = await resolveClient(request, deps.config);

    if (!client) {
        return door.envelope(401, "Invalid proxy API key", { type: "auth_error" });
    }

    const startedAt = performance.now();
    facts.startedAt = startedAt;
    const { bodyText, body } = await readDoorBody(request, door);
    facts.model = body.model;
    const session = client.session ? noteSessionRequest(client.session, body.claudeSessionId) : undefined;
    const tags = requestTagsFor(request.headers, session, body.conversationId);

    const gated = await gateModelRoute({
        client,
        config: deps.config,
        model: body.model,
        providers: deps.providers,
    });

    if ("refusal" in gated) {
        return refusalResponse(door.envelope, gated.refusal);
    }

    const { route, provider } = gated;
    const recorded: { exchange?: DoorExchange } = {};
    const response = await door.run({
        req: request,
        path: deps.path,
        config: deps.config,
        body,
        bodyText,
        client,
        session,
        tags,
        route,
        provider,
        startedAt,
        record: (exchange) => {
            recorded.exchange = exchange;
        },
    });
    const { exchange } = recorded;

    if (!exchange) {
        return response;
    }

    const elapsedMs = Math.round(performance.now() - startedAt);

    trackExchange({
        deps,
        route,
        client: client.name,
        proxyModel: body.model,
        status: response.status,
        elapsedMs,
        tags,
        exchange,
    });

    logger.info(
        {
            path: deps.path,
            model: body.model,
            upstreamModel: route.upstreamId,
            status: response.status,
            ...exchange.logFields,
            elapsedMs,
            ...tags,
            userAgent: request.headers.get("User-Agent") ?? undefined,
        },
        "ai-proxy: request"
    );

    return response;
}
