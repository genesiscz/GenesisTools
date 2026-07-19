import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { convertMessagesToInput } from "@app/ai-proxy/lib/chat-to-responses-body";
import { captureUpstreamFailure } from "@app/ai-proxy/lib/debug-capture";
import { clientAbortResponse } from "@app/ai-proxy/lib/providers/client-abort";
import { cooldownRemainingMs, markRateLimited, markSuccess, markUnhealthy } from "@app/ai-proxy/lib/providers/cooldown";
import { resolveOpenAiSubFailoverToken, resolveOpenAiSubToken } from "@app/ai-proxy/lib/providers/openai-sub-token";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { mapWhamError, parseRetryAfterSeconds } from "@app/ai-proxy/lib/providers/wham-errors";
import { responsesToChat } from "@app/ai-proxy/lib/translators/responses-to-chat";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import { getTodayUsageSummary, getUsageSummarySince } from "@app/ai-proxy/lib/usage/store";
import { extractPlanType, WHAM_BASE_URL } from "@genesiscz/utils/ai/openai/codex-auth";
import {
    fetchWhamModels,
    resolveOpenAiSubModel,
    tryFetchWhamModels,
    type WhamModelRecord,
} from "@genesiscz/utils/ai/openai/sub-models";
import { formatTokens } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

const WHAM_RESPONSES_URL = `${WHAM_BASE_URL}/responses`;

/**
 * Bills the owner's ChatGPT/Codex subscription. The ChatGPT WHAM backend speaks
 * the OpenAI Responses API (streaming-only), so `responses()` converts an
 * incoming chat- or responses-shaped body into a WHAM Responses request and
 * forwards it; `chatCompletions()` delegates to the shared `responsesToChat`
 * translator (which calls `responses()` and maps the Responses output back to
 * chat.completion / chat.completion.chunk).
 */
const MODALITY_CACHE_TTL_MS = 10 * 60_000;

export class OpenAiSubscriptionProvider implements ProxyProvider {
    readonly id = "openai-subscription";
    readonly accountFingerprint: string;
    private readonly account: AiProxyAccountConfig;
    private modalityRecords: WhamModelRecord[] | null = null;
    private modalityFetchedAt = 0;

    constructor(account: AiProxyAccountConfig) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
    }

    static async create(account: AiProxyAccountConfig): Promise<OpenAiSubscriptionProvider> {
        return new OpenAiSubscriptionProvider(account);
    }

    async listModels(): Promise<OpenAiModel[]> {
        const { token, accountId } = await resolveOpenAiSubToken(this.account);
        const records = await fetchWhamModels(token, accountId);

        return records
            .filter((record) => record.visibility === "list")
            .map((record) => ({
                id: `${this.account.name}/${this.account.providerSlug}/${record.slug}`,
                object: "model",
                created: 1_740_960_000,
                owned_by: "openai",
                description: `${record.displayName} via ChatGPT/Codex subscription`,
            }));
    }

    async chatCompletions(req: Request, model: string, bodyText: string): Promise<Response> {
        const proxyModel = `${this.account.name}/${this.account.providerSlug}/${model}`;
        const { response } = await responsesToChat({ provider: this, upstreamModel: model, proxyModel, req, bodyText });
        return response;
    }

    /**
     * Token candidates tried in order: the primary account source, then any
     * `openaiSub.failoverAccountNames`. Each has its own cooldown key.
     */
    private tokenCandidates(): Array<{
        key: string;
        resolve: (options?: { forceRefresh?: boolean }) => Promise<{ token: string; accountId?: string }>;
    }> {
        const candidates: Array<{
            key: string;
            resolve: (options?: { forceRefresh?: boolean }) => Promise<{ token: string; accountId?: string }>;
        }> = [
            {
                key: this.account.name,
                resolve: (options) => resolveOpenAiSubToken(this.account, options),
            },
        ];

        for (const failoverName of this.account.openaiSub?.failoverAccountNames ?? []) {
            candidates.push({
                key: `${this.account.name}:${failoverName}`,
                resolve: (options) => resolveOpenAiSubFailoverToken(failoverName, options),
            });
        }

        return candidates;
    }

    /**
     * Advertised input modalities for a model, from the live WHAM list (cached
     * 10 min). Returns undefined when unknown — the guard only blocks when it
     * KNOWS the model lacks image input; unknown models pass through so WHAM's
     * own error surfaces.
     */
    private async lookupInputModalities(concreteModel: string): Promise<string[] | undefined> {
        if (!this.modalityRecords || Date.now() - this.modalityFetchedAt > MODALITY_CACHE_TTL_MS) {
            try {
                const { token, accountId } = await resolveOpenAiSubToken(this.account);
                this.modalityRecords = await tryFetchWhamModels(token, accountId);
                this.modalityFetchedAt = Date.now();
            } catch (err) {
                logger.debug({ err, account: this.account.name }, "ai-proxy: modality lookup failed — skipping guard");
                return undefined;
            }
        }

        return this.modalityRecords?.find((record) => record.slug === concreteModel)?.inputModalities;
    }

    private async fetchWham({
        token,
        accountId,
        whamBodyText,
        signal,
    }: {
        token: string;
        accountId?: string;
        whamBodyText: string;
        signal: AbortSignal;
    }): Promise<Response> {
        return fetch(WHAM_RESPONSES_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "chatgpt-account-id": accountId ?? "",
                "Content-Type": "application/json",
                "OpenAI-Beta": "responses=experimental",
                originator: "codex_cli_rs",
                session_id: crypto.randomUUID(),
                Accept: "text/event-stream",
            },
            body: whamBodyText,
            signal,
        });
    }

    async responses(req: Request, model: string, bodyText: string): Promise<Response> {
        const concreteModel = resolveOpenAiSubModel(model, this.account.openaiSub?.aliases);

        let parsed: Record<string, unknown>;
        try {
            const parsedBody = SafeJSON.parse(bodyText, { strict: true });
            if (!isObject(parsedBody)) {
                return jsonError(400, "Invalid JSON body");
            }

            parsed = parsedBody;
        } catch (err) {
            logger.debug({ err }, "ai-proxy: openai-subscription got invalid JSON body");
            return jsonError(400, "Invalid JSON body");
        }

        if (bodyContainsImageInput(parsed)) {
            const modalities = await this.lookupInputModalities(concreteModel);

            if (modalities && !modalities.includes("image")) {
                const visionModels = (this.modalityRecords ?? [])
                    .filter((record) => record.visibility === "list" && record.inputModalities?.includes("image"))
                    .map((record) => record.slug);
                const hint = visionModels.length > 0 ? ` Vision-capable: ${visionModels.join(", ")}.` : "";

                return new Response(
                    SafeJSON.stringify({
                        error: {
                            message: `Model ${concreteModel} does not accept image input.${hint}`,
                            type: "invalid_request_error",
                            code: "unsupported_modality",
                        },
                    }),
                    { status: 400, headers: { "Content-Type": "application/json" } }
                );
            }
        }

        const wantStream = parsed.stream === true;
        const { body: whamBody, dropped } = buildWhamResponsesBody(parsed, concreteModel, {
            defaultReasoningEffort: this.account.openaiSub?.defaultReasoningEffort,
        });
        warnDroppedParamsOnce(dropped);
        const whamBodyText = SafeJSON.stringify(whamBody);

        const started = performance.now();
        let upstream: Response | undefined;
        let servedBy: string | undefined;
        let lastFailure: Response | undefined;

        for (const candidate of this.tokenCandidates()) {
            const coolingMs = cooldownRemainingMs(candidate.key);
            if (coolingMs > 0) {
                logger.debug(
                    { key: candidate.key, coolingMs, model: concreteModel },
                    "ai-proxy: skipping cooling codex account"
                );
                continue;
            }

            let token: string;
            let accountId: string | undefined;
            try {
                ({ token, accountId } = await candidate.resolve());
            } catch (err) {
                logger.warn({ err, key: candidate.key }, "ai-proxy: openai-subscription token resolution failed");
                lastFailure = jsonError(
                    502,
                    `Codex subscription token unavailable: ${err instanceof Error ? err.message : String(err)}`
                );
                continue;
            }

            let attempt: Response;
            try {
                attempt = await this.fetchWham({ token, accountId, whamBodyText, signal: req.signal });
            } catch (err) {
                const aborted = clientAbortResponse(err, { err, account: this.account.name });
                if (aborted) {
                    return aborted;
                }

                logger.warn({ err, key: candidate.key }, "ai-proxy: WHAM upstream fetch failed");
                lastFailure = jsonError(
                    502,
                    `Failed to reach ChatGPT upstream: ${err instanceof Error ? err.message : String(err)}`
                );
                continue;
            }

            if (attempt.status === 401) {
                // One forced refresh, then one retry. A second 401 means the
                // grant is dead — cool the account and move to the next one.
                void attempt.body?.cancel();
                try {
                    ({ token, accountId } = await candidate.resolve({ forceRefresh: true }));
                    attempt = await this.fetchWham({ token, accountId, whamBodyText, signal: req.signal });
                } catch (err) {
                    const aborted = clientAbortResponse(err, { err, account: this.account.name });
                    if (aborted) {
                        return aborted;
                    }

                    logger.warn({ err, key: candidate.key }, "ai-proxy: codex 401 refresh-retry failed");
                    markUnhealthy(candidate.key);
                    lastFailure = whamErrorResponse({ status: 401, bodyText: "" });
                    continue;
                }

                if (attempt.status === 401) {
                    const errorText = await attempt.text();
                    logger.warn(
                        { key: candidate.key, body: errorText.slice(0, 300) },
                        "ai-proxy: codex account still 401 after refresh — marking unhealthy"
                    );
                    markUnhealthy(candidate.key);
                    lastFailure = whamErrorResponse({ status: 401, bodyText: errorText });
                    continue;
                }
            }

            if (attempt.status === 429) {
                const retryAfterSec = parseRetryAfterSeconds(attempt.headers);
                const errorText = await attempt.text();
                const backoffMs = markRateLimited(candidate.key, retryAfterSec);
                lastFailure = whamErrorResponse({
                    status: 429,
                    bodyText: errorText,
                    retryAfterSec: retryAfterSec ?? Math.ceil(backoffMs / 1000),
                });
                continue;
            }

            if (!attempt.ok) {
                const errorText = await attempt.text();
                logger.warn(
                    {
                        key: candidate.key,
                        model: concreteModel,
                        status: attempt.status,
                        body: errorText.slice(0, 500),
                    },
                    "ai-proxy: WHAM upstream request failed"
                );
                captureUpstreamFailure({
                    provider: "openai-subscription",
                    account: this.account.name,
                    model: concreteModel,
                    status: attempt.status,
                    requestBody: whamBodyText,
                    responseBody: errorText,
                });

                return whamErrorResponse({ status: attempt.status, bodyText: errorText });
            }

            markSuccess(candidate.key);
            upstream = attempt;
            servedBy = candidate.key;
            break;
        }

        if (!upstream) {
            return lastFailure ?? jsonError(502, "All codex accounts are cooling down or unavailable.");
        }

        const elapsedMs = Math.round(performance.now() - started);
        const reasoning = isObject(whamBody.reasoning) ? whamBody.reasoning : undefined;

        logger.debug(
            {
                provider: "openai-subscription",
                account: this.account.name,
                servedBy,
                proxyModel: model,
                upstreamModel: concreteModel,
                reasoningEffort: reasoning && typeof reasoning.effort === "string" ? reasoning.effort : undefined,
                stream: wantStream,
                status: upstream.status,
                elapsedMs,
                dropped: dropped.length > 0 ? dropped : undefined,
                authSource: this.account.openaiSub?.accountName ? "ai-config" : "codex-auth.json",
            },
            "ai-proxy: WHAM upstream request ok"
        );

        if (!upstream.body) {
            return jsonError(502, "WHAM upstream returned no body");
        }

        const droppedHeader = dropped.length > 0 ? { "x-ai-proxy-dropped": dropped.join(",") } : undefined;

        if (wantStream) {
            return new Response(upstream.body, {
                status: 200,
                headers: {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache",
                    // Advertising keep-alive on a chunked SSE body breaks Node/undici
                    // clients on connection reuse (second request dies with
                    // "TypeError: terminated" / UND_ERR_SOCKET) — verified live via the
                    // eve tool-loop. curl tolerates it; undici does not. Close per stream.
                    Connection: "close",
                    "X-Accel-Buffering": "no",
                    ...droppedHeader,
                },
            });
        }

        // Non-streaming caller: WHAM only streams, so accumulate the SSE into a
        // Responses JSON. The final `response.completed` event carries empty
        // output on WHAM, so text is reassembled from output_text deltas.
        let accumulated: Awaited<ReturnType<typeof accumulateResponsesJson>>;
        try {
            accumulated = await accumulateResponsesJson(upstream.body);
        } catch (err) {
            const aborted = clientAbortResponse(err, { err, account: this.account.name });
            if (aborted) {
                return aborted;
            }

            logger.warn({ err, account: this.account.name }, "ai-proxy: failed to accumulate WHAM response");
            return jsonError(
                502,
                `Failed to read ChatGPT upstream response: ${err instanceof Error ? err.message : String(err)}`
            );
        }

        if (accumulated.failed) {
            logger.warn(
                { account: this.account.name, model: concreteModel, error: accumulated.error },
                "ai-proxy: WHAM stream reported response.failed"
            );
            captureUpstreamFailure({
                provider: "openai-subscription",
                account: this.account.name,
                model: concreteModel,
                status: 502,
                requestBody: whamBodyText,
                responseBody: accumulated.error,
            });
            return new Response(
                SafeJSON.stringify({
                    error: {
                        message: accumulated.error,
                        type: "upstream_error",
                        ...(accumulated.errorCode ? { code: accumulated.errorCode } : {}),
                    },
                }),
                { status: 502, headers: { "Content-Type": "application/json" } }
            );
        }

        return new Response(accumulated.body, {
            status: 200,
            headers: { "Content-Type": "application/json", ...droppedHeader },
        });
    }

    async getUsage(): Promise<UsageSummary> {
        // ChatGPT exposes no plan-quota endpoint we can trust, so this reports
        // proxy-observed traffic from the local usage store — never claim
        // upstream weekly-limit numbers here.
        const today = getTodayUsageSummary(this.account.name);
        const month = getUsageSummarySince(30, this.account.name);
        const summary =
            `proxy-observed: today ${today.requests} req / ${formatTokens(today.total_tokens)} tok · ` +
            `30d ${month.requests} req / ${formatTokens(month.total_tokens)} tok (not ChatGPT plan quota)`;

        let tier: string | undefined;
        try {
            const { token } = await resolveOpenAiSubToken(this.account);
            tier = extractPlanType(token);
        } catch (err) {
            logger.debug(
                { err, account: this.account.name },
                "ai-proxy: getUsage could not resolve codex token for tier"
            );
        }

        return {
            accountName: this.account.name,
            provider: "openai-subscription",
            tier,
            summary,
        };
    }
}

function partIsImage(part: unknown): boolean {
    return isObject(part) && (part.type === "image_url" || part.type === "input_image");
}

function messageHasImage(entry: unknown): boolean {
    return isObject(entry) && Array.isArray(entry.content) && entry.content.some(partIsImage);
}

/** True when the chat `messages` or Responses `input` carry image parts. */
export function bodyContainsImageInput(parsed: Record<string, unknown>): boolean {
    if (Array.isArray(parsed.messages) && parsed.messages.some(messageHasImage)) {
        return true;
    }

    return Array.isArray(parsed.input) && parsed.input.some(messageHasImage);
}

function extractText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("");
    }

    return "";
}

function mapChatToolsToResponses(tools: unknown, dropped?: string[]): unknown[] | undefined {
    if (!Array.isArray(tools)) {
        return undefined;
    }

    const mapped: unknown[] = [];

    for (const tool of tools) {
        if (!isObject(tool)) {
            continue;
        }

        // Already Responses-shaped (flat function tool).
        if (tool.type === "function" && typeof tool.name === "string") {
            mapped.push(tool);
            continue;
        }

        const fn = isObject(tool.function) ? tool.function : undefined;

        if (fn && typeof fn.name === "string") {
            mapped.push({
                type: "function",
                name: fn.name,
                description: typeof fn.description === "string" ? fn.description : undefined,
                parameters: fn.parameters ?? { type: "object", properties: {} },
            });
            continue;
        }

        // WHAM only accepts flat function tools — anything else is stripped.
        dropped?.push(`tools[type=${typeof tool.type === "string" ? tool.type : "unknown"}]`);
    }

    return mapped.length > 0 ? mapped : undefined;
}

/** Filter an already-Responses-shaped tools array down to what WHAM accepts. */
function mapResponsesTools(tools: unknown, dropped: string[]): unknown[] | undefined {
    if (!Array.isArray(tools)) {
        return undefined;
    }

    const kept: unknown[] = [];

    for (const tool of tools) {
        if (isObject(tool) && tool.type === "function") {
            kept.push(tool);
            continue;
        }

        dropped.push(`tools[type=${isObject(tool) && typeof tool.type === "string" ? tool.type : "unknown"}]`);
    }

    return kept.length > 0 ? kept : undefined;
}

const WHAM_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

export interface WhamBodyBuildResult {
    body: Record<string, unknown>;
    /** Client-sent parameters WHAM cannot enforce, silently stripped from the upstream body. */
    dropped: string[];
}

const warnedDroppedParams = new Set<string>();

/** Log each dropped-parameter name once per process so agent traffic doesn't spam the log. */
export function warnDroppedParamsOnce(dropped: string[]): void {
    for (const param of dropped) {
        if (warnedDroppedParams.has(param)) {
            continue;
        }

        warnedDroppedParams.add(param);
        logger.warn({ param }, "ai-proxy: WHAM does not accept this parameter — dropped (logged once per process)");
    }
}

/** Convert a chat- or responses-shaped body into a WHAM Responses request. */
export function buildWhamResponsesBody(
    parsed: Record<string, unknown>,
    model: string,
    options?: { defaultReasoningEffort?: "none" | "low" | "medium" | "high" }
): WhamBodyBuildResult {
    const body: Record<string, unknown> = {
        model,
        stream: true,
        store: false,
        include: [],
    };
    const dropped: string[] = [];

    if (Array.isArray(parsed.input)) {
        // Already a Responses body.
        body.input = parsed.input;

        if (typeof parsed.instructions === "string") {
            body.instructions = parsed.instructions;
        }

        if (Array.isArray(parsed.tools)) {
            const kept = mapResponsesTools(parsed.tools, dropped);

            if (kept) {
                body.tools = kept;
            }
        } else if (parsed.tools) {
            body.tools = parsed.tools;
        }
    } else {
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const instructions: string[] = [];
        const rest: unknown[] = [];

        for (const message of messages) {
            if (isObject(message) && (message.role === "system" || message.role === "developer")) {
                instructions.push(extractText(message.content));
                continue;
            }

            rest.push(message);
        }

        body.input = convertMessagesToInput(rest);

        if (instructions.length > 0) {
            body.instructions = instructions.join("\n\n");
        }

        const tools = mapChatToolsToResponses(parsed.tools, dropped);

        if (tools) {
            body.tools = tools;
        }
    }

    // WHAM allowlist probed live 2026-07-19 (Plus plan): max_output_tokens,
    // temperature, top_p, previous_response_id all 400 "Unsupported parameter";
    // store must stay false ("Store must be set to false"). Dropped rather than
    // forwarded — recorded in `dropped` so callers can surface it honestly.
    if (parsed.max_tokens != null || parsed.max_output_tokens != null) {
        dropped.push("max_tokens");
    }

    for (const param of ["temperature", "top_p", "previous_response_id"] as const) {
        if (parsed[param] != null) {
            dropped.push(param);
        }
    }

    if (parsed.store === true) {
        dropped.push("store");
    }

    if (isObject(parsed.reasoning)) {
        // Pass the client's reasoning through, clamping unknown efforts.
        const reasoning = { ...parsed.reasoning };

        if (typeof reasoning.effort === "string" && !WHAM_REASONING_EFFORTS.has(reasoning.effort)) {
            logger.debug({ effort: reasoning.effort }, "ai-proxy: clamped unknown reasoning effort to low");
            reasoning.effort = "low";
        }

        body.reasoning = reasoning;
    } else {
        const effort = options?.defaultReasoningEffort ?? "low";

        if (effort !== "none") {
            body.reasoning = { effort };
        }
    }

    return { body, dropped };
}

async function accumulateResponsesJson(
    stream: ReadableStream<Uint8Array>
): Promise<{ failed: false; body: string } | { failed: true; error: string; errorCode?: string }> {
    const raw = await new Response(stream).text();
    let text = "";
    const functionCalls: unknown[] = [];
    let completed: Record<string, unknown> = {};
    let failure: string | undefined;
    let failureCode: string | undefined;

    for (const line of raw.split("\n")) {
        const trimmed = line.trimStart();

        if (!trimmed.startsWith("data:")) {
            continue;
        }

        const payload = trimmed.slice("data:".length).trim();

        if (payload.length === 0 || payload === "[DONE]") {
            continue;
        }

        let event: unknown;
        try {
            event = SafeJSON.parse(payload, { strict: true });
        } catch (err) {
            logger.debug({ err, payload }, "ai-proxy: WHAM SSE line parse failed");
            continue;
        }

        if (!isObject(event)) {
            continue;
        }

        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            text += event.delta;
            continue;
        }

        if (event.type === "response.output_item.done" && isObject(event.item) && event.item.type === "function_call") {
            functionCalls.push(event.item);
            continue;
        }

        if (event.type === "response.completed" && isObject(event.response)) {
            completed = event.response;
            continue;
        }

        if (event.type === "response.failed") {
            const response = isObject(event.response) ? event.response : undefined;
            const error = response && isObject(response.error) ? response.error : undefined;
            failure = error && typeof error.message === "string" ? error.message : "WHAM response.failed";
            failureCode = error && typeof error.code === "string" ? error.code : undefined;
        }
    }

    if (failure) {
        return { failed: true, error: failure, errorCode: failureCode };
    }

    const output: unknown[] = [];

    if (text.length > 0) {
        output.push({
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
        });
    }

    output.push(...functionCalls);

    return { failed: false, body: SafeJSON.stringify({ ...completed, object: "response", output }) };
}

function jsonError(status: number, message: string): Response {
    return new Response(SafeJSON.stringify({ error: { message } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** OpenAI-shaped error response for a failed WHAM request, with Retry-After on 429. */
function whamErrorResponse({
    status,
    bodyText,
    retryAfterSec,
}: {
    status: number;
    bodyText: string;
    retryAfterSec?: number;
}): Response {
    const envelope = mapWhamError({ status, bodyText, retryAfterSec });
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (status === 429 && retryAfterSec != null) {
        headers["Retry-After"] = String(retryAfterSec);
    }

    return new Response(SafeJSON.stringify(envelope), { status, headers });
}
