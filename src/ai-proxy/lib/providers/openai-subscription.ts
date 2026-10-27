import { createHash, randomUUID } from "node:crypto";
import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { convertMessagesToInput } from "@app/ai-proxy/lib/chat-to-responses-body";
import { codexModelInfo } from "@app/ai-proxy/lib/codex-catalog";
import { captureUpstreamFailure } from "@app/ai-proxy/lib/debug-capture";
import { clientAbortResponse } from "@app/ai-proxy/lib/providers/client-abort";
import { cooldownRemainingMs, markRateLimited, markSuccess, markUnhealthy } from "@app/ai-proxy/lib/providers/cooldown";
import { relayHeaders } from "@app/ai-proxy/lib/providers/http-relay";
import { resolveOpenAiSubFailoverToken, resolveOpenAiSubToken } from "@app/ai-proxy/lib/providers/openai-sub-token";
import type {
    OpenAiModel,
    ProviderInspectionOptions,
    ProviderRequestContext,
    ProxyProvider,
} from "@app/ai-proxy/lib/providers/types";
import {
    anthropicClientStatus,
    classifyUpstreamFailure,
    failureResponse,
    failureText,
    readStreamHead,
    type UpstreamFailure,
} from "@app/ai-proxy/lib/providers/upstream-failure";
import { mapWhamError, parseRetryAfterSeconds } from "@app/ai-proxy/lib/providers/wham-errors";
import {
    createWhamItemHarvestTransform,
    rememberWhamOutputItem,
    resolveWhamItemReferences,
    whamItemScope,
} from "@app/ai-proxy/lib/providers/wham-item-store";
import {
    braveSearchFn,
    type EmulationOutcome,
    emulateWebSearch,
    messageToAnthropicSse,
    nativeTranslationLoss,
    nativeWebSearch,
    parseWebSearchServerTool,
    unsupportedNativeResponse,
    type WebSearchServerTool,
    webSearchResponse,
} from "@app/ai-proxy/lib/server-tools/web-search";
import {
    type BackgroundResult,
    backgroundInFlight,
    backgroundKey,
    backgroundResult,
    clearBackground,
    compactionPoint,
    estimateTokens,
    matchBackground,
    prefixHash,
    shouldStartBackground,
    trackBackground,
} from "@app/ai-proxy/lib/sessions/background-compaction";
import {
    compactionFromSse,
    compactionMarkers,
    compactionNote,
    compactionRecoveryMessage,
    expandCompactionMarkers,
    hasCompactionFallback,
    loadCompaction,
    newCompactionId,
    saveCompaction,
} from "@app/ai-proxy/lib/sessions/codex-compaction";
import { type CompactionEvent, recordCompactionEvent } from "@app/ai-proxy/lib/sessions/compaction-events";
import { loginAccountName, noteBlockedCompaction, readSessionRecord } from "@app/ai-proxy/lib/sessions/records";
import { backgroundCompactionSettings, compactionSettings } from "@app/ai-proxy/lib/sessions/settings";
import {
    anthropicToResponses,
    stripReasoningInput,
} from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-responses";
import {
    CLAUDE_CODE_AGENT_TOOL,
    isClaudeCodeCompactionRetry,
    isClaudeCodeCompactionTurn,
    limitCompactionSummary,
    sessionAgentModelWins,
    withoutCompactionPrompt,
} from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import { ensureToolRequiredArrays } from "@app/ai-proxy/lib/translators/formats/anthropic/ensure-tool-required";
import { toAnthropicErrorResponse } from "@app/ai-proxy/lib/translators/formats/anthropic/error-envelope";
import {
    responsesSseToAnthropic,
    responsesToAnthropicMessage,
} from "@app/ai-proxy/lib/translators/formats/anthropic/grok-responses-to-anthropic";
import {
    accountHash8,
    type EnvelopeRejection,
    isReasoningReplayRejection,
    openReasoningEnvelope,
    packReasoningEnvelope,
    type ReasoningEnvelopeStamp,
} from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-envelope";
import { responsesToChat } from "@app/ai-proxy/lib/translators/responses-to-chat";
import type { AiProxyAccountConfig, ThinkingPresentationMode, UsageSummary } from "@app/ai-proxy/lib/types";
import { getTodayUsageSummary, getUsageSummarySince, recordUsageRequest } from "@app/ai-proxy/lib/usage/store";
import { extractPlanType, WHAM_BASE_URL } from "@genesiscz/utils/ai/openai/codex-auth";
import { type CodexModelInfo, resolveCodexEffort } from "@genesiscz/utils/ai/openai/codex-models";
import {
    fetchWhamModels,
    resolveOpenAiSubModel,
    tryFetchWhamModels,
    type WhamModelRecord,
} from "@genesiscz/utils/ai/openai/sub-models";
import {
    claudeSessionIdFromMetadata,
    type PromptCacheKey,
    resolvePromptCacheKey,
} from "@genesiscz/utils/ai/prompt-cache-key";
// The one predicate in the repo for "did this failure happen below HTTP?".
// Duplicating it here is how the poll gate and the proxy would drift apart.
import { isTransportFailure } from "@genesiscz/utils/ai/usage-poll/poll-gate";
import { env } from "@genesiscz/utils/env";
import { formatTokens } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/**
 * Bills the owner's ChatGPT/Codex subscription. The ChatGPT WHAM backend speaks
 * the OpenAI Responses API (streaming-only), so `responses()` converts an
 * incoming chat- or responses-shaped body into a WHAM Responses request and
 * forwards it; `chatCompletions()` delegates to the shared `responsesToChat`
 * translator (which calls `responses()` and maps the Responses output back to
 * chat.completion / chat.completion.chunk).
 */
const MODALITY_CACHE_TTL_MS = 10 * 60_000;

class CompactionRestoreError extends Error {
    constructor(
        readonly marker: string,
        readonly permanent: boolean,
        message: string,
        readonly missingId: string = marker,
        readonly upstreamResponse?: Response
    ) {
        super(message);
    }
}

/** Read a compaction stream with the same 120-second idle limit as response capture. */
export async function readCompactionText(response: Response, idleMs = 120_000): Promise<string> {
    if (!response.body) {
        return "";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    try {
        while (true) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const idle = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Compaction upstream stream timed out.")), idleMs);
            });
            let chunk: Awaited<ReturnType<typeof reader.read>>;

            try {
                chunk = await Promise.race([reader.read(), idle]);
            } finally {
                clearTimeout(timer);
            }

            if (chunk.done) {
                return text + decoder.decode();
            }

            text += decoder.decode(chunk.value, { stream: true });
        }
    } catch (error) {
        // An upstream that already failed rejects cancel() with the same error; the throw below reports it once.
        await reader.cancel(error).catch(() => undefined);
        throw error;
    }
}

function inputHasFallback(input: unknown[], id: string): boolean {
    return input.some(
        (item) =>
            isObject(item) &&
            Array.isArray(item.content) &&
            item.content.some(
                (part) => isObject(part) && typeof part.text === "string" && hasCompactionFallback(part.text, id)
            )
    );
}

/** Bound compaction preparation and send SSE pings while the provider is still preparing a response. */
export async function compactionDispatch({
    signal,
    stream,
    run,
    timeoutMs = 900_000,
    pingMs = 15_000,
}: {
    signal: AbortSignal;
    stream: boolean;
    run: (signal: AbortSignal) => Promise<Response>;
    timeoutMs?: number;
    pingMs?: number;
}): Promise<Response> {
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
    }, timeoutMs);
    const onClientAbort = () => abort.abort(signal.reason);
    signal.addEventListener("abort", onClientAbort, { once: true });

    if (signal.aborted) {
        onClientAbort();
    }

    const stopped = new Promise<Response>((resolve) => {
        const finish = () =>
            resolve(jsonError(timedOut ? 504 : 499, timedOut ? "Compaction timed out." : "Client cancelled."));

        if (abort.signal.aborted) {
            finish();
        } else {
            abort.signal.addEventListener("abort", finish, { once: true });
        }
    });
    const pending = abort.signal.aborted ? stopped : Promise.race([run(abort.signal), stopped]);
    const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onClientAbort);
    };

    if (!stream) {
        try {
            return await pending;
        } finally {
            cleanup();
        }
    }

    // Keep a real HTTP status when preparation finishes before the first keepalive.
    let firstPing: ReturnType<typeof setTimeout> | undefined;
    let early: Response | undefined;
    try {
        early = await Promise.race([
            pending,
            new Promise<undefined>((resolve) => {
                firstPing = setTimeout(() => resolve(undefined), pingMs);
            }),
        ]);
    } catch (error) {
        cleanup();
        throw error;
    } finally {
        clearTimeout(firstPing);
    }

    if (early) {
        clearTimeout(timer);

        if (!early.body) {
            cleanup();
            return early;
        }

        const source = early.body.getReader();
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const chunk = await source.read();

                    if (chunk.done) {
                        cleanup();
                        controller.close();
                    } else {
                        controller.enqueue(chunk.value);
                    }
                } catch (error) {
                    cleanup();
                    controller.error(error);
                }
            },
            cancel(reason) {
                abort.abort(reason);
                cleanup();
                return source.cancel(reason).catch(() => undefined);
            },
        });
        return new Response(body, { status: early.status, statusText: early.statusText, headers: early.headers });
    }

    const encoder = new TextEncoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            const ping = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), pingMs);
            void (async () => {
                try {
                    const response = await pending;
                    clearTimeout(timer);

                    if (!response.ok) {
                        const error = await toAnthropicErrorResponse(response);
                        controller.enqueue(encoder.encode(`event: error\ndata: ${await error.text()}\n\n`));
                    } else if (response.body) {
                        reader = response.body.getReader();

                        while (!cancelled) {
                            const chunk = await reader.read();

                            if (chunk.done) {
                                break;
                            }

                            controller.enqueue(chunk.value);
                        }
                    }
                } catch (error) {
                    if (!cancelled) {
                        const payload = { type: "error", error: { type: "api_error", message: String(error) } };
                        controller.enqueue(encoder.encode(`event: error\ndata: ${SafeJSON.stringify(payload)}\n\n`));
                    }
                } finally {
                    clearInterval(ping);
                    cleanup();

                    if (!cancelled) {
                        controller.close();
                    }
                }
            })();
        },
        cancel(reason) {
            cancelled = true;
            abort.abort(reason);
            cleanup();
            void reader?.cancel(reason).catch(() => undefined);
        },
    });

    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

/** A background compaction is a full-context request; past this it is abandoned (a native one took 155 s at 430K). */
const BACKGROUND_COMPACTION_TIMEOUT_MS = 15 * 60_000;
/** How the usage ledger names a background compaction's request. */
export const BACKGROUND_COMPACTION_PATH = "/v1/messages#background-compaction";

/** A Responses usage object as the token counts a compaction event and Claude Code's usage carry. */
function usageTokens(usage: Record<string, unknown> | undefined): {
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
} {
    const details = isObject(usage?.input_tokens_details) ? usage.input_tokens_details : {};

    return {
        ...(typeof usage?.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
        ...(typeof details.cached_tokens === "number" ? { cachedTokens: details.cached_tokens } : {}),
        ...(typeof usage?.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    };
}

/** Claude Code's answer to its compaction turn: one text block, as SSE or JSON like the request asked. */
function compactionReply(input: {
    model: string;
    text: string;
    tokens: { inputTokens?: number; cachedTokens?: number; outputTokens?: number };
    stream: boolean;
}): Response {
    const { inputTokens = 0, cachedTokens = 0, outputTokens = 0 } = input.tokens;
    const reply = {
        id: `msg_${randomUUID().replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        model: input.model,
        content: [{ type: "text", text: input.text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
            input_tokens: Math.max(0, inputTokens - cachedTokens),
            cache_read_input_tokens: cachedTokens,
            output_tokens: outputTokens,
        },
    };

    return input.stream
        ? new Response(messageToAnthropicSse(reply), { headers: { "Content-Type": "text/event-stream" } })
        : new Response(SafeJSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
}

const WASTE_REASONS: Record<"login_changed" | "history_changed" | "tail_too_large", string> = {
    login_changed: "another Codex login made it, and this login cannot read it",
    history_changed: "the conversation before it changed (a rewound, edited or replaced turn)",
    tail_too_large: "too much happened after it, so the next turns would have reached the limit again",
};

/**
 * The line the agent reads in its compaction summary when a background run went unused: one more full-context request
 * was spent. The agent tells the user once; the proxy log and `tools ai-proxy monitor` keep the details.
 */
export function backgroundWasteNotice(
    result: Pick<BackgroundResult, "readyAt">,
    reason: keyof typeof WASTE_REASONS,
    durationMs: number
): string {
    const at = new Date(result.readyAt).toTimeString().slice(0, 5);

    return (
        `Proxy notice: the compaction ai-proxy prepared in the background at ${at} could not be used, because ` +
        `${WASTE_REASONS[reason]}. This compaction read the whole context again (${Math.round(durationMs / 1000)} s). ` +
        "Tell the user this in one sentence in your next reply, once."
    );
}

/**
 * The stream unchanged, and `onUsage` with the `response.completed` usage when it passes by. Only lines that carry
 * that event are parsed, so the cost stays a substring check per chunk.
 */
export function tapCompletedUsage(
    body: ReadableStream<Uint8Array>,
    onUsage: (usage: Record<string, unknown>) => void
): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    let pending = "";
    let done = false;

    const scan = (text: string) => {
        pending += text;
        let newline = pending.indexOf("\n");

        while (newline >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            newline = pending.indexOf("\n");

            if (done || !line.startsWith("data: ") || !line.includes('"response.completed"')) {
                continue;
            }

            try {
                const event: unknown = SafeJSON.parse(line.slice("data: ".length), { strict: true });

                if (isObject(event) && isObject(event.response) && isObject(event.response.usage)) {
                    done = true;
                    onUsage(event.response.usage);
                }
            } catch (error) {
                logger.debug({ error }, "ai-proxy: could not read a response.completed frame for its usage");
            }
        }
    };

    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                controller.enqueue(chunk);
                scan(decoder.decode(chunk, { stream: true }));
            },
            flush() {
                scan(`${decoder.decode()}\n`);
            },
        })
    );
}

/** Who gets an account failure: the Anthropic route's client (Claude Code) gets the status it acts on. */
interface FailureClient {
    anthropic: boolean;
    /** The session record the request came from, for the switch command. */
    sessionId?: string;
    /** Filled by `respond`: the login that answered, which signs the reply's reasoning. */
    servedIdentity?: string;
}

interface TokenCandidate {
    key: string;
    label: string;
    /** The login whose tokens these are: a reasoning envelope is stamped with it, and only it can decrypt one. */
    identity: string;
    primary: boolean;
    resolve: (options?: { forceRefresh?: boolean }) => Promise<{ token: string; accountId?: string }>;
}

export class OpenAiSubscriptionProvider implements ProxyProvider {
    readonly id = "openai-subscription";
    readonly accountFingerprint: string;
    readonly acceptsPromptCacheKey = true;
    /** The `:effort` suffix rides in the Anthropic body as `reasoning_effort`, which the Responses body reads. */
    readonly messagesAcceptsReasoningEffort = true;
    /** Native `/v1/messages`: set unless `AI_PROXY_CODEX_MESSAGES_ROUTE=chat` restores the chat hop. */
    readonly messages?: ProxyProvider["messages"];
    private readonly account: AiProxyAccountConfig;
    /** The live WHAM model list, when the image guard or `listModels` already fetched it (10 min). */
    private liveRecords: WhamModelRecord[] | null = null;
    private liveFetchedAt = 0;
    /** Reasoning item ids the upstream refused to decrypt: never replayed again by this process. */
    private readonly deadReasoning = new Set<string>();

    constructor(account: AiProxyAccountConfig) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);

        if (env.aiProxy.getCodexMessagesRoute() === "responses") {
            this.messages = (req, model, bodyText, context) => {
                let parsed: unknown;
                try {
                    parsed = SafeJSON.parse(bodyText, { strict: true });
                } catch (error) {
                    logger.debug({ error }, "ai-proxy: could not inspect the messages body for compaction");
                    return this.nativeMessages(req, model, bodyText, context);
                }

                if (!isObject(parsed) || !isClaudeCodeCompactionTurn(parsed)) {
                    return this.nativeMessages(req, model, bodyText, context);
                }

                return compactionDispatch({
                    signal: req.signal,
                    stream: parsed.stream === true,
                    run: (signal) =>
                        this.nativeMessages(
                            new Request(req.url, {
                                method: req.method,
                                headers: req.headers,
                                ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: bodyText }),
                                signal,
                            }),
                            model,
                            bodyText,
                            context
                        ),
                });
            };
        }
    }

    static async create(account: AiProxyAccountConfig): Promise<OpenAiSubscriptionProvider> {
        return new OpenAiSubscriptionProvider(account);
    }

    /** Cooldowns and the failover list apply only when the account turns this on (❓ DECISION 10 c). */
    private get failover(): boolean {
        return this.account.failover === true;
    }

    /** An account-level failure as the client sees it: the readable text, at the status its kind calls for. */
    private failureResponse(
        failure: UpstreamFailure,
        model: string,
        client: FailureClient | undefined,
        tried: string[]
    ): Response {
        const login = this.account.openaiSub?.accountName;
        const text = failureText(failure, {
            agent: "codex",
            proxyAccount: this.account.name,
            // A session's in-memory account (`login:<name>`) is known by its login.
            account: login && this.account.name === loginAccountName(login) ? login : this.account.name,
            ...(login ? { login } : {}),
            model,
            ...(client?.sessionId ? { sessionId: client.sessionId } : {}),
            failover: this.failover,
            tried,
        });
        const status = client?.anthropic ? anthropicClientStatus(failure) : failure.status;

        logger.warn(
            {
                account: this.account.name,
                model,
                kind: failure.kind,
                upstreamStatus: failure.status,
                status,
                code: failure.code,
            },
            "ai-proxy: codex account failure, shown to the client"
        );
        return failureResponse(failure, text, status);
    }

    async listModels(options?: ProviderInspectionOptions): Promise<OpenAiModel[]> {
        const { token, accountId } = await resolveOpenAiSubToken(this.account, { noRefresh: options?.probe });
        const records = await fetchWhamModels(token, accountId, this.account.baseUrl);
        this.liveRecords = records;
        this.liveFetchedAt = Date.now();

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

    async chatCompletions(
        req: Request,
        model: string,
        bodyText: string,
        options?: { thinkingMode?: ThinkingPresentationMode }
    ): Promise<Response> {
        const proxyModel = `${this.account.name}/${this.account.providerSlug}/${model}`;
        // Without the resolved mode this silently defaulted to "raw", which
        // prepends reasoning into content — the configured mode never applied.
        const { response } = await responsesToChat({
            provider: this,
            upstreamModel: model,
            proxyModel,
            req,
            bodyText,
            thinkingMode: options?.thinkingMode,
        });
        return response;
    }

    /**
     * Token candidates tried in order: the primary account source, then, only while the account's `failover` is on,
     * any `openaiSub.failoverAccountNames`. Each has its own cooldown key.
     */
    private tokenCandidates(): TokenCandidate[] {
        const candidates: TokenCandidate[] = [
            {
                key: this.account.name,
                label: this.account.name,
                identity: this.primaryIdentity(),
                primary: true,
                resolve: (options) => resolveOpenAiSubToken(this.account, options),
            },
        ];

        for (const failoverName of this.failover ? (this.account.openaiSub?.failoverAccountNames ?? []) : []) {
            candidates.push({
                key: `${this.account.name}:${failoverName}`,
                label: failoverName,
                identity: failoverName,
                primary: false,
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
        if (!this.liveRecords || Date.now() - this.liveFetchedAt > MODALITY_CACHE_TTL_MS) {
            try {
                const { token, accountId } = await resolveOpenAiSubToken(this.account);
                this.liveRecords = await tryFetchWhamModels(token, accountId, this.account.baseUrl);
                this.liveFetchedAt = Date.now();
            } catch (err) {
                logger.debug({ err, account: this.account.name }, "ai-proxy: modality lookup failed — skipping guard");
                return undefined;
            }
        }

        return this.liveRecords?.find((record) => record.slug === concreteModel)?.inputModalities;
    }

    private async fetchWham({
        token,
        accountId,
        whamBodyText,
        sessionId,
        signal,
    }: {
        token: string;
        accountId?: string;
        whamBodyText: string;
        /**
         * The conversation's cache key. The backend routes the prompt cache by the session HEADER (probed
         * 2026-10-25: a fixed header hit 11 of 12 warm requests, the body key alone 0 of 12), so a random id per
         * request threw the cache away. Both spellings go out: `session_id` (older clients) and codex-rs's
         * `session-id` + `thread-id`.
         */
        sessionId: string;
        signal: AbortSignal;
    }): Promise<Response> {
        // `baseUrl` points an account at a WHAM-compatible endpoint, e.g. the fake upstream of an error test.
        return fetch(`${(this.account.baseUrl ?? WHAM_BASE_URL).replace(/\/$/, "")}/responses`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "chatgpt-account-id": accountId ?? "",
                "Content-Type": "application/json",
                "OpenAI-Beta": "responses=experimental",
                originator: "codex_cli_rs",
                session_id: sessionId,
                "session-id": sessionId,
                "thread-id": sessionId,
                Accept: "text/event-stream",
            },
            body: whamBodyText,
            signal,
        });
    }

    async responses(req: Request, model: string, bodyText: string): Promise<Response> {
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

        return this.respond(req, model, parsed);
    }

    /** The primary login: the one a request tries first, and the one replayed reasoning must come from. */
    private primaryIdentity(): string {
        return this.account.openaiSub?.accountName ?? this.account.name;
    }

    /**
     * Anthropic `/v1/messages` straight to the WHAM Responses wire. The chat hop had no slot for reasoning items;
     * here each one rides in a thinking block's signature (a `gtr1.` envelope) and comes back whole next turn.
     */
    private async nativeMessages(
        req: Request,
        model: string,
        bodyText: string,
        context?: ProviderRequestContext,
        /** Set when a native compaction failed: this run writes Claude Code's text summary instead. */
        writtenCompaction = false
    ): Promise<Response> {
        let parsed: Record<string, unknown>;
        try {
            const parsedBody = SafeJSON.parse(bodyText, { strict: true });

            if (!isObject(parsedBody)) {
                return toAnthropicErrorResponse(jsonError(400, "Invalid JSON body"));
            }

            parsed = parsedBody;
        } catch (err) {
            logger.debug({ err }, "ai-proxy: openai-subscription got an invalid /v1/messages body");
            return toAnthropicErrorResponse(jsonError(400, "Invalid JSON body"));
        }

        // Claude Code's WebSearch: a nested request offering the web_search server tool (S2 section 4). Turned into a
        // plain function tool, the model only ever called it with no answer to come back.
        const webSearch = parseWebSearchServerTool(parsed);

        if (webSearch) {
            return this.webSearchMessages(req, model, parsed, webSearch, context);
        }

        const concreteModel = resolveOpenAiSubModel(model, this.account.openaiSub?.aliases);
        const fresh = Date.now() - this.liveFetchedAt <= MODALITY_CACHE_TTL_MS ? this.liveRecords : null;
        const catalog = codexModelInfo(concreteModel, fresh);
        const stamp: ReasoningEnvelopeStamp = {
            provider: "codex",
            accountHash: accountHash8(this.primaryIdentity()),
            model: concreteModel,
            compHash: catalog?.compHash ?? "0",
        };
        const replay = { kept: [] as string[], dropped: {} as Partial<Record<EnvelopeRejection | "dead", number>> };
        const compaction = isClaudeCodeCompactionTurn(parsed);
        const nativeCompaction = compaction && !writtenCompaction && compactionSettings().mode === "native";
        const summaryWords = compaction && !nativeCompaction ? compactionSettings().words : undefined;
        const claudeSessionId = claudeSessionIdFromMetadata(parsed.metadata);
        const clientAgent = req.headers.get("user-agent") ?? undefined;
        const eventBase: Omit<CompactionEvent, "ts" | "kind"> = {
            ...(context?.sessionId ? { session: context.sessionId } : {}),
            ...(claudeSessionId ? { claudeSession: claudeSessionId } : {}),
            model: concreteModel,
            ...(clientAgent ? { client: clientAgent } : {}),
        };

        if (compaction && !writtenCompaction) {
            recordCompactionEvent({ ...eventBase, kind: "turn", mode: nativeCompaction ? "native" : "summary" });

            if (isClaudeCodeCompactionRetry(parsed)) {
                recordCompactionEvent({
                    ...eventBase,
                    kind: "retry",
                    reason: "Claude Code asked for the summary again: the last reply had no <summary> tag",
                });
            }
        }

        // Background compaction runs only for a ccx session, whose record knows where Claude Code will compact.
        const point = compactionPoint(context?.sessionId ? readSessionRecord(context.sessionId) : undefined);
        const background = backgroundCompactionSettings();
        const threadKey =
            claudeSessionId && point && background.enabled ? backgroundKey(claudeSessionId, parsed.system) : undefined;

        if (nativeCompaction) {
            // The server compacts what came before; Claude Code's summary prompt would only end the cached prefix.
            parsed = withoutCompactionPrompt(parsed);
        }

        if (summaryWords) {
            parsed = limitCompactionSummary(parsed, summaryWords);
        }

        // System messages stay in place (`appendDeveloperMessage`): hoisted, they broke the prompt cache.
        let responsesBody = anthropicToResponses(ensureToolRequiredArrays(parsed), concreteModel, {
            // A Read of an image comes back as a tool result; WHAM takes it as input_image (codex-rs does the same).
            toolResultImages: true,
            reasoningItem: (thinking) => {
                const opened = openReasoningEnvelope(thinking.signature, stamp);

                if (!opened.ok || this.deadReasoning.has(opened.item.id)) {
                    const reason = opened.ok ? "dead" : opened.reason;
                    replay.dropped[reason] = (replay.dropped[reason] ?? 0) + 1;
                    return undefined;
                }

                replay.kept.push(contentHash(opened.item.encrypted_content));
                return { type: "reasoning", ...opened.item };
            },
        });

        if (Array.isArray(responsesBody.tools)) {
            responsesBody.tools = responsesBody.tools.map((tool) => (isObject(tool) ? nonStrictByDefault(tool) : tool));
        }

        // Claude Code forbids tools in its compaction prompt in words only; a Codex model may still call one, which
        // Claude Code refuses, and three refused compactions end the session.
        if (compaction && !nativeCompaction) {
            responsesBody.tool_choice = "none";
        }

        if (context?.promptCacheKey) {
            responsesBody.prompt_cache_key = context.promptCacheKey.key;
        }

        // The effort rides inside `reasoning`, which every body builder branch reads (a top-level `reasoning_effort`
        // is read only when no `reasoning` object exists). An `:effort` suffix, stamped as `reasoning_effort`, wins
        // over Claude Code's `/effort` (`output_config.effort`); the catalog check refuses an effort the model lacks.
        const clientEffort =
            isObject(parsed.output_config) && typeof parsed.output_config.effort === "string"
                ? parsed.output_config.effort.trim()
                : "";
        // A compaction turn writes a summary of what is already known: the session's xhigh only made it slower (6 to 8
        // minutes per compaction on 2026-10-27), so it runs at the compaction effort when the model has that effort.
        const compactionEffort = compaction && !nativeCompaction ? compactionSettings().effort : undefined;
        const effort =
            compactionEffort && (!catalog || catalog.efforts.includes(compactionEffort))
                ? compactionEffort
                : typeof responsesBody.reasoning_effort === "string"
                  ? responsesBody.reasoning_effort
                  : clientEffort;
        delete responsesBody.reasoning_effort;
        responsesBody.reasoning = {
            ...reasoningOptions(catalog, this.account.openaiSub?.reasoningSummary),
            ...(effort ? { effort } : {}),
        };

        logger.debug(
            {
                model: concreteModel,
                replayed: replay.kept.length,
                replayedHashes: replay.kept,
                dropped: Object.keys(replay.dropped).length > 0 ? replay.dropped : undefined,
                compaction: responsesBody.tool_choice === "none" ? true : undefined,
            },
            "ai-proxy: codex /v1/messages reasoning replay"
        );

        // A Claude Code client gets an account failure at the status it acts on, with this session's switch command.
        const client: FailureClient = {
            anthropic: true,
            ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
        };
        const rawInput = Array.isArray(responsesBody.input) ? responsesBody.input : [];
        const template = responsesBody;
        if (compactionMarkers(rawInput).length > 0) {
            let expanded = rawInput;
            try {
                const restored = await compactionDispatch({
                    signal: req.signal,
                    stream: false,
                    timeoutMs: 120_000,
                    run: async (signal) => {
                        const restoreReq = new Request(req.url, {
                            method: req.method,
                            headers: req.headers,
                            ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: bodyText }),
                            signal,
                        });
                        expanded = await expandCompactionMarkers(rawInput, async (id) => {
                            try {
                                return await this.compactionItem({
                                    id,
                                    req: restoreReq,
                                    model,
                                    template,
                                    accountHash: stamp.accountHash,
                                    client,
                                });
                            } catch (error) {
                                if (
                                    error instanceof CompactionRestoreError &&
                                    !signal.aborted &&
                                    inputHasFallback(rawInput, id)
                                ) {
                                    logger.warn({ error, id }, "ai-proxy: using the readable compaction fallback");
                                    return undefined;
                                }

                                if (error instanceof CompactionRestoreError) {
                                    throw new CompactionRestoreError(
                                        id,
                                        error.permanent,
                                        error.message,
                                        error.missingId,
                                        error.upstreamResponse
                                    );
                                }

                                throw error;
                            }
                        });
                        return new Response(null, { status: 204 });
                    },
                });

                if (!restored.ok) {
                    return toAnthropicErrorResponse(restored);
                }

                responsesBody = { ...responsesBody, input: expanded };
            } catch (error) {
                if (!(error instanceof CompactionRestoreError)) {
                    throw error;
                }

                if (error.upstreamResponse) {
                    return toAnthropicErrorResponse(error.upstreamResponse);
                }

                if (!error.permanent) {
                    return toAnthropicErrorResponse(jsonError(503, error.message));
                }

                const session = context?.sessionId
                    ? await noteBlockedCompaction(context.sessionId, error.marker)
                    : undefined;

                if (session && error.missingId !== error.marker) {
                    await noteBlockedCompaction(session.id, error.missingId);
                }

                recordCompactionEvent({ ...eventBase, kind: "blocked", id: error.marker, reason: error.message });

                return toAnthropicErrorResponse(
                    jsonError(
                        400,
                        `${error.message} ${compactionRecoveryMessage(session?.id, error.marker, error.missingId)}`
                    )
                );
            }
        }

        if (nativeCompaction) {
            const startedAt = Date.now();
            let notice: ((durationMs: number) => string) | undefined;

            if (threadKey && point) {
                const answered = await this.answerFromBackground({
                    key: threadKey,
                    point,
                    rawInput,
                    accountHash: stamp.accountHash,
                    model,
                    stream: parsed.stream === true,
                    eventBase,
                    startedAt,
                });

                if (answered.response) {
                    return answered.response;
                }

                notice = answered.notice;
            }

            return this.compactNatively({
                req,
                model,
                bodyText,
                context,
                parsed,
                responsesBody,
                rawInput,
                stamp,
                client,
                eventBase,
                startedAt,
                notice,
                threadKey,
            });
        }

        // A turn near the compaction point starts the background compaction of what it sends, once its usage is in.
        const sentBody = responsesBody;
        const onUsage =
            threadKey && point
                ? (usage: Record<string, unknown>) => {
                      const contextTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;

                      if (shouldStartBackground({ key: threadKey, contextTokens, point, settings: background })) {
                          trackBackground(
                              threadKey,
                              contextTokens,
                              this.runBackgroundCompaction({
                                  req,
                                  model,
                                  concreteModel,
                                  body: sentBody,
                                  rawInput,
                                  stamp,
                                  contextTokens,
                                  sessionId: context?.sessionId,
                                  eventBase,
                              })
                          );
                      }
                  }
                : undefined;

        // The recall quest's mode B: the turn goes up without the reasoning carried from earlier turns.
        if (env.aiProxy.getReasoningReplay() === "drop" && replay.kept.length > 0) {
            logger.info(
                { model: concreteModel, dropped: replay.kept.length },
                "ai-proxy: reasoning replay off (AI_PROXY_REASONING_REPLAY=drop)"
            );
            responsesBody = stripReasoningInput(responsesBody);
        }

        let response = await this.respond(req, model, responsesBody, client);

        if (!response.ok) {
            const errorText = await response.text();
            const replayed = Array.isArray(responsesBody.input)
                ? responsesBody.input.filter((item) => isObject(item) && item.type === "reasoning")
                : [];

            if (replayed.length === 0 || !isReasoningReplayRejection(response.status, errorText)) {
                return toAnthropicErrorResponse(
                    new Response(errorText, { status: response.status, headers: response.headers })
                );
            }

            for (const item of replayed) {
                if (isObject(item) && typeof item.id === "string") {
                    this.deadReasoning.add(item.id);
                }
            }

            logger.warn(
                { model: concreteModel, items: replayed.length, status: response.status },
                "ai-proxy: WHAM refused replayed reasoning; retrying once without it, those items stay dropped"
            );
            response = await this.respond(req, model, stripReasoningInput(responsesBody), client);

            if (!response.ok) {
                return toAnthropicErrorResponse(response);
            }
        }

        const signReasoning = (item: Record<string, unknown>): string => {
            if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
                return "";
            }

            // A failover login served this turn: its reasoning is its own, and the primary login could not decrypt it.
            const servedBy = client.servedIdentity;
            const signer = servedBy ? { ...stamp, accountHash: accountHash8(servedBy) } : stamp;

            return packReasoningEnvelope(signer, {
                id: typeof item.id === "string" ? item.id : `rs_${randomUUID()}`,
                encrypted_content: item.encrypted_content,
                summary: Array.isArray(item.summary) ? item.summary : [],
            });
        };

        const sessionAgents = new Set(context?.sessionAgents ?? []);
        const keepAgentModel = sessionAgentModelWins(sessionAgents);
        const toolInput =
            sessionAgents.size > 0
                ? (name: string) => (name === CLAUDE_CODE_AGENT_TOOL ? keepAgentModel : undefined)
                : undefined;

        if (parsed.stream === true && response.body) {
            // A model at capacity answers 200 and fails before its first output; as a 529, Claude Code retries it.
            const head = await readStreamHead(response.body);

            if ("failure" in head) {
                return toAnthropicErrorResponse(this.failureResponse(head.failure, concreteModel, client, []));
            }

            return new Response(
                responsesSseToAnthropic(onUsage ? tapCompletedUsage(head.body, onUsage) : head.body, {
                    model,
                    signReasoning,
                    label: "codex",
                    toolInput,
                    signal: req.signal,
                }),
                {
                    status: response.status,
                    headers: relayHeaders(response),
                }
            );
        }

        const envelope = SafeJSON.parse(await response.text(), { strict: true });

        if (onUsage && isObject(envelope) && isObject(envelope.usage)) {
            onUsage(envelope.usage);
        }

        return new Response(
            SafeJSON.stringify(
                responsesToAnthropicMessage(isObject(envelope) ? envelope : {}, {
                    model,
                    signReasoning,
                    label: "codex",
                    toolInput,
                })
            ),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
    }

    /**
     * Claude Code's compaction turn, compacted the Codex way: the turn's request plus `compaction_trigger`, at the
     * session's effort, so the cached prefix holds. Claude Code gets a note with a marker; the item and the history it
     * compacted go to disk for the later turns. Any failure writes the text summary instead, as before.
     */
    private async compactNatively(input: {
        req: Request;
        model: string;
        bodyText: string;
        context: ProviderRequestContext | undefined;
        parsed: Record<string, unknown>;
        responsesBody: Record<string, unknown>;
        rawInput: unknown[];
        stamp: ReasoningEnvelopeStamp;
        client: FailureClient;
        eventBase: Omit<CompactionEvent, "ts" | "kind">;
        startedAt: number;
        /** Why a background result could not answer this turn, for the agent to tell the user. */
        notice?: (durationMs: number) => string;
        threadKey?: string;
    }): Promise<Response> {
        const { req, model, client } = input;
        const sent = Array.isArray(input.responsesBody.input) ? input.responsesBody.input : [];
        const response = await this.respond(
            req,
            model,
            { ...input.responsesBody, input: [...sent, { type: "compaction_trigger" }], stream: true },
            client
        );
        const { item, usage, summary } = response.ok ? compactionFromSse(await readCompactionText(response)) : {};

        if (!item) {
            recordCompactionEvent({
                ...input.eventBase,
                kind: "turn",
                mode: "summary",
                reason: `Codex native compaction gave no compaction item (HTTP ${response.status}); writing the text summary`,
            });
            return this.nativeMessages(req, model, input.bodyText, input.context, true);
        }

        // Native compaction can return only an encrypted item. Do not issue another model request for a summary.
        if (req.signal.aborted) {
            return toAnthropicErrorResponse(jsonError(499, "Compaction was cancelled."));
        }

        const servedBy = client.servedIdentity;
        const accountHash = servedBy ? accountHash8(servedBy) : input.stamp.accountHash;
        const id = newCompactionId();
        saveCompaction({
            id,
            model: input.stamp.model,
            createdAt: new Date().toISOString(),
            items: { [accountHash]: item },
            history: input.rawInput,
        });
        const durationMs = Date.now() - input.startedAt;
        const tokens = usageTokens(usage);
        const notice = input.notice?.(durationMs);

        if (input.threadKey) {
            clearBackground(input.threadKey);
        }

        recordCompactionEvent({ ...input.eventBase, kind: "done", mode: "native", id, durationMs, ...tokens });

        return compactionReply({
            model,
            text: `<summary>\n${compactionNote(id, summary)}${notice ? `\n${notice}` : ""}\n</summary>`,
            tokens,
            stream: input.parsed.stream === true,
        });
    }

    /**
     * A compaction turn answered from the background run of its thread, when that run can stand for it. A run in
     * flight is awaited (the turn's keepalives are already running), like Codex does, instead of a second request.
     */
    private async answerFromBackground(input: {
        key: string;
        point: number;
        rawInput: unknown[];
        accountHash: string;
        model: string;
        stream: boolean;
        eventBase: Omit<CompactionEvent, "ts" | "kind">;
        startedAt: number;
    }): Promise<{ response?: Response; notice?: (durationMs: number) => string }> {
        await backgroundInFlight(input.key);
        const result = backgroundResult(input.key);

        if (!result) {
            return {};
        }

        clearBackground(input.key);
        const match = matchBackground({
            result,
            rawInput: input.rawInput,
            accountHash: input.accountHash,
            point: input.point,
            tailTokens: estimateTokens,
            settings: backgroundCompactionSettings(),
        });

        if (!match.use) {
            recordCompactionEvent({
                ...input.eventBase,
                kind: "background-wasted",
                reason: match.reason,
                inputTokens: result.inputTokens,
                cachedTokens: result.cachedTokens,
                outputTokens: result.outputTokens,
            });
            return { notice: (durationMs) => backgroundWasteNotice(result, match.reason, durationMs) };
        }

        const id = newCompactionId();
        saveCompaction({
            id,
            model: typeof input.eventBase.model === "string" ? input.eventBase.model : input.model,
            createdAt: new Date().toISOString(),
            items: { [result.accountHash]: result.item },
            history: input.rawInput,
            ...(match.tail.length > 0 ? { tail: { account: result.accountHash, items: match.tail } } : {}),
        });
        const durationMs = Date.now() - input.startedAt;
        const tokens = {
            inputTokens: result.inputTokens,
            cachedTokens: result.cachedTokens,
            outputTokens: result.outputTokens,
        };
        recordCompactionEvent({
            ...input.eventBase,
            kind: "background-used",
            id,
            durationMs,
            tailItems: match.tail.length,
            ...tokens,
        });
        recordCompactionEvent({ ...input.eventBase, kind: "done", mode: "background", id, durationMs, ...tokens });

        return {
            response: compactionReply({
                model: input.model,
                text: `<summary>\n${compactionNote(id)}\n</summary>`,
                tokens,
                stream: input.stream,
            }),
        };
    }

    /**
     * Compacts what one turn sent, in the background: the same request plus `compaction_trigger`, at its effort and
     * on its cached prefix, on a request of its own that the client's hang-up does not cancel. Never throws.
     */
    private async runBackgroundCompaction(input: {
        req: Request;
        model: string;
        concreteModel: string;
        body: Record<string, unknown>;
        rawInput: unknown[];
        stamp: ReasoningEnvelopeStamp;
        contextTokens: number;
        sessionId?: string;
        eventBase: Omit<CompactionEvent, "ts" | "kind">;
    }): Promise<BackgroundResult | undefined> {
        const startedAt = Date.now();
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), BACKGROUND_COMPACTION_TIMEOUT_MS);
        const client: FailureClient = { anthropic: true, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
        const sent = Array.isArray(input.body.input) ? input.body.input : [];
        recordCompactionEvent({ ...input.eventBase, kind: "background-start", inputTokens: input.contextTokens });

        try {
            const request = new Request(input.req.url, {
                method: "POST",
                headers: input.req.headers,
                body: "{}",
                signal: abort.signal,
            });
            const response = await this.respond(
                request,
                input.model,
                { ...input.body, input: [...sent, { type: "compaction_trigger" }], stream: true },
                client
            );
            const { item, usage } = response.ok ? compactionFromSse(await readCompactionText(response)) : {};
            const tokens = usageTokens(usage);
            this.recordBackgroundUsage({ ...input, status: response.status, startedAt, tokens });

            if (!item) {
                recordCompactionEvent({
                    ...input.eventBase,
                    kind: "background-failed",
                    reason: `no compaction item (HTTP ${response.status})`,
                    durationMs: Date.now() - startedAt,
                    ...tokens,
                });
                return undefined;
            }

            const servedBy = client.servedIdentity;
            const result: BackgroundResult = {
                item,
                accountHash: servedBy ? accountHash8(servedBy) : input.stamp.accountHash,
                prefixLength: input.rawInput.length,
                prefixHash: prefixHash(input.rawInput),
                prefix: input.rawInput,
                contextTokens: input.contextTokens,
                startedAt,
                readyAt: Date.now(),
                ...tokens,
            };
            recordCompactionEvent({
                ...input.eventBase,
                kind: "background-ready",
                durationMs: result.readyAt - startedAt,
                ...tokens,
            });

            return result;
        } catch (error) {
            recordCompactionEvent({
                ...input.eventBase,
                kind: "background-failed",
                reason: error instanceof Error ? error.message : String(error),
                durationMs: Date.now() - startedAt,
            });
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    }

    /** The background request is real spend: it goes into the usage ledger like a client's request. */
    private recordBackgroundUsage(input: {
        model: string;
        concreteModel: string;
        sessionId?: string;
        eventBase: Omit<CompactionEvent, "ts" | "kind">;
        status: number;
        startedAt: number;
        tokens: { inputTokens?: number; cachedTokens?: number; outputTokens?: number };
    }): void {
        const { inputTokens = 0, cachedTokens = 0, outputTokens = 0 } = input.tokens;
        const session = input.sessionId ?? input.eventBase.claudeSession;

        try {
            recordUsageRequest({
                ts: new Date().toISOString(),
                account: this.account.name,
                provider: this.id,
                proxyModel: input.model,
                upstreamModel: input.concreteModel,
                path: BACKGROUND_COMPACTION_PATH,
                status: input.status,
                elapsedMs: Date.now() - input.startedAt,
                stream: true,
                usage: {
                    prompt_tokens: Math.max(0, inputTokens - cachedTokens),
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                    cache_read_input_tokens: cachedTokens,
                },
                ...(session ? { tags: { session, label: "background-compaction" } } : {}),
                compaction: true,
            });
        } catch (error) {
            logger.warn({ error }, "ai-proxy: could not record the background compaction's usage");
        }
    }

    /**
     * The compaction item behind a marker, for this login. Another login cannot read an item, so the first request it
     * serves after a switch compacts the saved history once more there (one uncached read, which the switch costs
     * anyway) and keeps that item too.
     */
    private async compactionItem(input: {
        id: string;
        req: Request;
        model: string;
        template: Record<string, unknown>;
        accountHash: string;
        client: FailureClient;
        ancestors?: ReadonlySet<string>;
    }): Promise<unknown[]> {
        if (input.ancestors?.has(input.id)) {
            throw new CompactionRestoreError(input.id, true, `Compaction history contains a cycle at ${input.id}.`);
        }

        const record = loadCompaction(input.id);

        if (!record) {
            throw new CompactionRestoreError(input.id, true, `Compaction record ${input.id} is missing or unreadable.`);
        }

        const held = record.items[input.accountHash];

        if (held) {
            return record.tail?.account === input.accountHash ? [held, ...record.tail.items] : [held];
        }

        const ancestors = new Set(input.ancestors);
        ancestors.add(input.id);
        const history = await expandCompactionMarkers(record.history, (id) =>
            this.compactionItem({ ...input, id, ancestors })
        );
        const cleanHistory = history.filter((item) => !isObject(item) || item.type !== "reasoning");
        const response = await this.respond(
            input.req,
            input.model,
            { ...input.template, input: [...cleanHistory, { type: "compaction_trigger" }], stream: true },
            input.client
        );
        if (!response.ok) {
            throw new CompactionRestoreError(
                input.id,
                false,
                `Could not restore compaction ${input.id}.`,
                input.id,
                response
            );
        }

        let item: Record<string, unknown> | undefined;
        try {
            item = response.ok ? compactionFromSse(await readCompactionText(response)).item : undefined;
        } catch (error) {
            logger.warn({ error, id: input.id }, "ai-proxy: could not read the recompaction stream");
            throw new CompactionRestoreError(input.id, false, `Could not read compaction ${input.id} for this login.`);
        }

        if (!item) {
            logger.warn({ id: input.id, status: response.status }, "ai-proxy: recompacting saved history failed");
            throw new CompactionRestoreError(
                input.id,
                false,
                `Could not restore compaction ${input.id} for this login.`
            );
        }

        if (input.req.signal.aborted) {
            throw new CompactionRestoreError(input.id, false, `Compaction ${input.id} was cancelled.`);
        }

        saveCompaction({ ...record, items: { ...record.items, [input.accountHash]: item } });
        recordCompactionEvent({ kind: "recompacted", id: input.id, model: input.model, reason: "another Codex login" });

        return [item];
    }

    /**
     * The web_search server tool on the Codex agent: one WHAM request with OpenAI's hosted `web_search` tool, whose
     * searches come back as `server_tool_use` and `web_search_tool_result` blocks with real titles and URLs. When the
     * hosted path cannot carry the request or fails, and BRAVE_API_KEY is set, the Brave loop runs over this route's
     * own turns instead.
     */
    private async webSearchMessages(
        req: Request,
        model: string,
        body: Record<string, unknown>,
        tool: WebSearchServerTool,
        context?: ProviderRequestContext
    ): Promise<Response> {
        const client: FailureClient = {
            anthropic: true,
            ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
        };
        const loss = nativeTranslationLoss(body, tool, "openai");
        logger.info({ model, maxUses: tool.maxUses, loss }, "ai-proxy: running web_search server tool for codex");

        const run = async (signal?: AbortSignal): Promise<EmulationOutcome | Response> => {
            const native =
                loss === undefined
                    ? await nativeWebSearch({
                          body,
                          tool,
                          dialect: "openai",
                          callResponses: async (responsesBody) => {
                              // The conversation's key, not one derived from the search prompt.
                              if (context?.promptCacheKey) {
                                  responsesBody.prompt_cache_key = context.promptCacheKey.key;
                              }

                              const response = await this.respond(req, model, responsesBody, client);
                              return response.ok ? response : toAnthropicErrorResponse(response);
                          },
                      })
                    : unsupportedNativeResponse(
                          "codex",
                          loss,
                          "the Codex hosted search takes plain text and an allow-list only"
                      );

            if (!(native instanceof Response)) {
                return native;
            }

            const braveKey = env.brave.getKey();

            if (braveKey === undefined) {
                return native;
            }

            logger.warn(
                { status: native.status, model, loss },
                "ai-proxy: codex hosted web_search unavailable — falling back to the Brave loop"
            );
            return emulateWebSearch({
                body,
                tool,
                signal,
                search: braveSearchFn(braveKey, signal),
                callUpstream: (turnBody) => this.nativeMessages(req, model, SafeJSON.stringify(turnBody), context),
            });
        };

        return webSearchResponse(body.stream === true, run);
    }

    /**
     * One Responses-shaped request to WHAM, with the 401 refresh and the error map; with `failover` on, also the
     * account pool and the 429 cooling.
     */
    private async respond(
        req: Request,
        model: string,
        parsed: Record<string, unknown>,
        client?: FailureClient
    ): Promise<Response> {
        const concreteModel = resolveOpenAiSubModel(model, this.account.openaiSub?.aliases);

        if (bodyContainsImageInput(parsed)) {
            const modalities = await this.lookupInputModalities(concreteModel);

            if (modalities && !modalities.includes("image")) {
                const visionModels = (this.liveRecords ?? [])
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
        // Stored items are private to the presenting client; see wham-item-store.ts.
        const itemScope = whamItemScope(req);
        const fresh = Date.now() - this.liveFetchedAt <= MODALITY_CACHE_TTL_MS ? this.liveRecords : null;
        const catalog = codexModelInfo(concreteModel, fresh);
        const {
            body: whamBody,
            dropped,
            effortError,
            cacheKey,
        } = buildWhamResponsesBody(parsed, concreteModel, {
            defaultReasoningEffort: this.account.openaiSub?.defaultReasoningEffort,
            itemScope,
            catalog,
            clientSessionHeader: req.headers.get("session-id") ?? req.headers.get("session_id") ?? undefined,
        });
        // A body with nothing to key on (no client key, no instructions, no input) still gets one id per request.
        const sessionId = cacheKey?.key ?? randomUUID();

        if (effortError) {
            logger.info({ account: this.account.name, model: concreteModel, effortError }, "ai-proxy: effort refused");
            return new Response(
                SafeJSON.stringify({
                    error: {
                        message: effortError,
                        type: "invalid_request_error",
                        param: "reasoning.effort",
                        code: "unsupported_effort",
                    },
                }),
                { status: 400, headers: { "Content-Type": "application/json" } }
            );
        }

        warnDroppedParamsOnce(dropped);
        const whamBodyText = SafeJSON.stringify(whamBody);
        // Replayed reasoning was produced by the primary login; another login cannot decrypt it, and its 400 would
        // mark every replayed item dead. A failover candidate gets the body without it.
        let failoverBodyText: string | undefined;
        const bodyTextFor = (candidate: TokenCandidate): string => {
            if (candidate.primary || !hasReasoningInput(whamBody)) {
                return whamBodyText;
            }

            failoverBodyText ??= SafeJSON.stringify(stripReasoningInput(whamBody));
            return failoverBodyText;
        };

        const started = performance.now();
        let upstream: Response | undefined;
        let servedBy: string | undefined;
        let lastFailure: Response | undefined;
        const tried: string[] = [];

        for (const candidate of this.tokenCandidates()) {
            const coolingMs = this.failover ? cooldownRemainingMs(candidate.key) : 0;
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
            tried.push(candidate.label);
            try {
                attempt = await this.fetchWham({
                    token,
                    accountId,
                    whamBodyText: bodyTextFor(candidate),
                    sessionId,
                    signal: req.signal,
                });
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
                // One forced refresh, then one retry, on the same login: token upkeep, not a move. A second 401
                // means the grant is dead: shown, or with failover on, the account cools and the next one runs.
                void attempt.body?.cancel();
                try {
                    ({ token, accountId } = await candidate.resolve({ forceRefresh: true }));
                    attempt = await this.fetchWham({
                        token,
                        accountId,
                        whamBodyText: bodyTextFor(candidate),
                        sessionId,
                        signal: req.signal,
                    });
                } catch (err) {
                    const aborted = clientAbortResponse(err, { err, account: this.account.name });
                    if (aborted) {
                        return aborted;
                    }

                    logger.warn({ err, key: candidate.key }, "ai-proxy: codex 401 refresh-retry failed");

                    // A refresh that never reached auth.openai.com says NOTHING
                    // about the grant. Cooling the account for 15 minutes and
                    // answering 401 told the client its login had died because
                    // DNS blinked. `markUnhealthy` cannot make this call itself:
                    // it never sees the error, and its other call site is a real
                    // 401 the server sent after a refresh that did go through.
                    if (isTransportFailure(err)) {
                        lastFailure = jsonError(
                            502,
                            `Failed to refresh the Codex subscription token: ${err instanceof Error ? err.message : String(err)}`
                        );
                        continue;
                    }

                    if (this.failover) {
                        markUnhealthy(candidate.key);
                    }

                    lastFailure = this.failureResponse({ kind: "auth", status: 401 }, concreteModel, client, tried);
                    continue;
                }

                if (attempt.status === 401) {
                    const errorText = await attempt.text();
                    logger.warn(
                        { key: candidate.key, body: errorText.slice(0, 300) },
                        "ai-proxy: codex account still 401 after refresh"
                    );

                    if (this.failover) {
                        markUnhealthy(candidate.key);
                    }

                    lastFailure = this.failureResponse(
                        classifyUpstreamFailure({ status: 401, bodyText: errorText }) ?? { kind: "auth", status: 401 },
                        concreteModel,
                        client,
                        tried
                    );
                    continue;
                }
            }

            if (attempt.status === 429) {
                const errorText = await attempt.text();
                const backoffMs = this.failover
                    ? markRateLimited(candidate.key, parseRetryAfterSeconds(attempt.headers))
                    : undefined;
                const retryAfterSec =
                    parseRetryAfterSeconds(attempt.headers) ??
                    (backoffMs === undefined ? undefined : Math.ceil(backoffMs / 1000));
                const failure = classifyUpstreamFailure({ status: 429, bodyText: errorText, retryAfterSec }) ?? {
                    kind: "rate-limit",
                    status: 429,
                };
                lastFailure = this.failureResponse(failure, concreteModel, client, tried);
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

                const failure = classifyUpstreamFailure({ status: attempt.status, bodyText: errorText });
                return failure
                    ? this.failureResponse(failure, concreteModel, client, tried)
                    : whamErrorResponse({ status: attempt.status, bodyText: errorText });
            }

            markSuccess(candidate.key);
            upstream = attempt;
            servedBy = candidate.key;

            if (client) {
                client.servedIdentity = candidate.primary ? undefined : candidate.identity;
            }
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
                // Sent as prompt_cache_key and as the session_id, session-id and thread-id headers.
                cacheKey: cacheKey ? `${cacheKey.key} (${cacheKey.source})` : undefined,
            },
            "ai-proxy: WHAM upstream request ok"
        );

        if (!upstream.body) {
            return jsonError(502, "WHAM upstream returned no body");
        }

        const droppedHeader = dropped.length > 0 ? { "x-ai-proxy-dropped": dropped.join(",") } : undefined;

        if (wantStream) {
            return new Response(upstream.body.pipeThrough(createWhamItemHarvestTransform(itemScope)), {
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
            accumulated = await accumulateResponsesJson(upstream.body, itemScope);
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

    async getUsage(options?: ProviderInspectionOptions): Promise<UsageSummary> {
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
            const { token } = await resolveOpenAiSubToken(this.account, { noRefresh: options?.probe });
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

/**
 * A function tool the proxy built from a non-strict shape (a chat tool, an Anthropic tool), with `strict: false` unless
 * the client chose. WHAM treats a function tool without `strict` as strict, and the model then fills every optional
 * field: Claude Code's Agent tool came back with `isolation: "worktree"` and a `team_name` in 3 of 3 trials, against
 * `prompt` only with `strict: false` (2026-10-25). codex-rs sends `strict: false` on every function tool. A
 * `/v1/responses` client's tools pass as sent: its own API has the same default.
 */
function nonStrictByDefault(tool: Record<string, unknown>): Record<string, unknown> {
    return typeof tool.strict === "boolean" ? tool : { ...tool, strict: false };
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
            mapped.push(nonStrictByDefault(tool));
            continue;
        }

        const fn = isObject(tool.function) ? tool.function : undefined;

        if (fn && typeof fn.name === "string") {
            mapped.push(
                nonStrictByDefault({
                    type: "function",
                    name: fn.name,
                    description: typeof fn.description === "string" ? fn.description : undefined,
                    parameters: fn.parameters ?? { type: "object", properties: {} },
                    ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
                })
            );
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
        // `web_search` is OpenAI's hosted search, sent the way codex-rs sends it; WHAM runs it server-side.
        if (isObject(tool) && (tool.type === "function" || tool.type === "web_search")) {
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
    /** Set when the catalog says the model has no such effort: the caller answers 400 with this text. */
    effortError?: string;
    /** The conversation's cache key, sent as `prompt_cache_key` and as the session headers. */
    cacheKey?: PromptCacheKey;
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
    // `itemScope` is required, not optional: a caller that forgot it would share
    // one store partition with every other client, which is the bug this fixes.
    options: {
        defaultReasoningEffort?: "none" | "low" | "medium" | "high";
        itemScope: string;
        /**
         * The model's catalog record. With efforts listed, the effort is checked against the model's own list: `max`
         * passes, `ultra` resolves like codex-rs, anything else is refused. Without one (an unknown model), the
         * older fixed allowlist and its `max` to `xhigh` clamp apply.
         */
        catalog?: CodexModelInfo;
        /** A `session-id` / `session_id` header the client sent (a native Codex client keys its cache by it). */
        clientSessionHeader?: string;
    }
): WhamBodyBuildResult {
    const body: Record<string, unknown> = {
        model,
        stream: true,
        store: false,
        // With store:false, encrypted reasoning is the ONLY way a client can
        // replay its reasoning next turn — `include: []` made cross-turn
        // continuity structurally impossible. Codex CLI itself requests exactly
        // this include alongside store:false.
        include: ["reasoning.encrypted_content"],
    };
    const dropped: string[] = [];

    if (Array.isArray(parsed.input)) {
        // Already a Responses body. Inline any item_reference pointers — WHAM
        // has no store to resolve them against (see wham-item-store.ts).
        const resolved = resolveWhamItemReferences(options.itemScope, parsed.input);
        body.input = resolved.input;

        if (resolved.unresolved.length > 0) {
            dropped.push("item_reference");
            logger.warn(
                { unresolved: resolved.unresolved, orphanedOutputs: resolved.orphanedOutputs },
                "ai-proxy: dropped item_reference input items with no stored record (proxy restarted mid-conversation?)"
            );
        }

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

        // Forwarded as sent. Dropping them ran every request as "auto": Claude Code's compaction turn needs "none",
        // and a client that turned parallel calls off meant it.
        if (parsed.tool_choice !== undefined) {
            body.tool_choice = parsed.tool_choice;
        }

        if (typeof parsed.parallel_tool_calls === "boolean") {
            body.parallel_tool_calls = parsed.parallel_tool_calls;
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

    // A hosted search names the pages it read only when asked (probed on WHAM 2026-10-26); Claude Code lists them.
    if (Array.isArray(body.tools) && body.tools.some((tool) => isObject(tool) && tool.type === "web_search")) {
        body.include = ["reasoning.encrypted_content", "web_search_call.action.sources"];
    }

    const cacheKey = resolveWhamCacheKey(parsed, body, model, options.clientSessionHeader);

    if (cacheKey) {
        body.prompt_cache_key = cacheKey.key;
    }

    if (options.catalog && options.catalog.efforts.length > 0) {
        const effortError = applyCatalogEffort({ parsed, body, model, catalog: options.catalog, options });
        return { body, dropped, effortError, cacheKey };
    }

    if (isObject(parsed.reasoning)) {
        // Pass the client's reasoning through, clamping unknown efforts. The
        // `:max` suffix lands HERE when the client already sent a reasoning
        // object (applyReasoningEffortToBody fills the nested slot), so it
        // needs the same strongest-accepted mapping as the else-branch —
        // clamping it to "low" ran the user's `:max` ask at the WEAKEST effort.
        const reasoning = { ...parsed.reasoning };

        if (reasoning.effort === "max") {
            logger.debug({ model }, "ai-proxy: WHAM has no 'max' effort — using xhigh, the strongest it accepts");
            reasoning.effort = "xhigh";
        }

        if (typeof reasoning.effort === "string" && !WHAM_REASONING_EFFORTS.has(reasoning.effort)) {
            logger.debug({ effort: reasoning.effort }, "ai-proxy: clamped unknown reasoning effort to low");
            reasoning.effort = "low";
        }

        body.reasoning = reasoning;
    } else {
        // A `:<effort>` model-id suffix arrives here as a top-level
        // `reasoning_effort` (applyReasoningEffortToBody only fills
        // `reasoning.effort` when the client already sent that object). Reading
        // it is what makes `account/openai/gpt-5.6-sol:xhigh` actually run at xhigh
        // instead of silently falling back to the account default.
        //
        // `max` is a documented proxy suffix that WHAM does not accept. Dropping
        // it to the account default would make `:max` quieter than `:xhigh`,
        // which is the opposite of what the user asked for, so it maps to the
        // strongest effort WHAM does accept.
        const stamped = typeof parsed.reasoning_effort === "string" ? parsed.reasoning_effort : undefined;
        const requested = stamped === "max" ? "xhigh" : stamped;

        if (stamped === "max") {
            logger.debug({ model }, "ai-proxy: WHAM has no 'max' effort — using xhigh, the strongest it accepts");
        }

        const effort =
            requested && WHAM_REASONING_EFFORTS.has(requested) ? requested : (options.defaultReasoningEffort ?? "low");

        if (effort !== "none") {
            body.reasoning = { effort };
        }
    }

    return { body, dropped, cacheKey };
}

/**
 * The key the client chose (its `prompt_cache_key`, else its session header) wins and is forwarded unchanged. A
 * `/v1/messages` request arrives with Claude Code's session id already stamped as `prompt_cache_key` by the
 * Anthropic translation. Any other client gets a key from the model, the instructions and the first input item,
 * which every later turn of the same conversation repeats.
 */
function resolveWhamCacheKey(
    parsed: Record<string, unknown>,
    body: Record<string, unknown>,
    model: string,
    clientSessionHeader: string | undefined
): PromptCacheKey | undefined {
    const clientKey = typeof parsed.prompt_cache_key === "string" ? parsed.prompt_cache_key : clientSessionHeader;
    const first = Array.isArray(body.input) ? body.input[0] : undefined;

    if (!clientKey && body.instructions === undefined && first === undefined) {
        return undefined;
    }

    return resolvePromptCacheKey({ clientKey, content: { model, system: body.instructions ?? "", first } });
}

/**
 * Effort for a model the catalog knows. The nested `reasoning.effort` wins over a stamped top-level
 * `reasoning_effort` (a `:effort` model-id suffix), as before. With none, the account default applies, then the
 * model's own default (codex-rs sends `default_reasoning_level`), then `low`. Returns the refusal text, if any.
 */
function applyCatalogEffort({
    parsed,
    body,
    model,
    catalog,
    options,
}: {
    parsed: Record<string, unknown>;
    body: Record<string, unknown>;
    model: string;
    catalog: CodexModelInfo;
    options: { defaultReasoningEffort?: "none" | "low" | "medium" | "high" };
}): string | undefined {
    const nested = isObject(parsed.reasoning) ? { ...parsed.reasoning } : undefined;
    const requested =
        nested && typeof nested.effort === "string"
            ? nested.effort
            : typeof parsed.reasoning_effort === "string"
              ? parsed.reasoning_effort
              : undefined;

    if (requested === undefined) {
        const fallback = options.defaultReasoningEffort ?? catalog.defaultEffort ?? "low";

        if (fallback === "none") {
            if (nested) {
                body.reasoning = nested;
            }

            return undefined;
        }

        // A configured default goes through the same check as a requested effort: `ultra` is mapped, and an effort
        // the model lacks is refused here instead of by WHAM.
        const resolvedDefault = resolveCodexEffort(catalog, fallback);

        if (!resolvedDefault.ok) {
            return `${resolvedDefault.message} (the default effort for ${model})`;
        }

        body.reasoning = { ...nested, effort: resolvedDefault.effort };
        return undefined;
    }

    const resolved = resolveCodexEffort(catalog, requested);

    if (!resolved.ok) {
        return resolved.message;
    }

    if (resolved.mappedFrom) {
        logger.debug({ model, from: resolved.mappedFrom, to: resolved.effort }, "ai-proxy: resolved Codex effort");
    }

    body.reasoning = { ...nested, effort: resolved.effort };
    return undefined;
}

function hasReasoningInput(body: Record<string, unknown>): boolean {
    return Array.isArray(body.input) && body.input.some((item) => isObject(item) && item.type === "reasoning");
}

/** The first 12 hex of a SHA-256: enough to match a blob across turns in a log, nothing of its content. */
function contentHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * The `reasoning` options of a `/v1/messages` request. A summary shows the model's reasoning as Claude Code
 * thinking text (the default where the model takes the parameter). A Responses Lite model keeps the reasoning of every
 * turn (`context: "all_turns"`), as codex-rs sends it; WHAM accepts it with classic tools (2026-10-25 probe b).
 */
function reasoningOptions(
    catalog: CodexModelInfo | undefined,
    summary: "none" | "auto" | "detailed" = "auto"
): Record<string, unknown> {
    const reasoning: Record<string, unknown> = {};

    if (summary !== "none" && catalog?.supportsReasoningSummaryParameter !== false) {
        reasoning.summary = summary;
    }

    if (catalog?.useResponsesLite && env.aiProxy.getCodexAllTurns()) {
        reasoning.context = "all_turns";
    }

    return reasoning;
}

const SSE_LINE_END = /\r\n|\r|\n/;

/**
 * Decode complete SSE frames while retaining only the unfinished frame between reads. A line ends
 * at CRLF, LF or a lone CR, as the SSE grammar allows; a CR that ends a read waits for the next
 * read, which may carry its LF.
 */
async function* whamSsePayloads(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let data: string[] = [];
    try {
        while (true) {
            const chunk = await reader.read();
            pending += decoder.decode(chunk.value, { stream: !chunk.done });
            let end = SSE_LINE_END.exec(pending);
            while (end && !(end[0] === "\r" && end.index === pending.length - 1 && !chunk.done)) {
                const line = pending.slice(0, end.index);
                pending = pending.slice(end.index + end[0].length);
                if (line === "") {
                    if (data.length > 0) {
                        yield data.join("\n");
                        data = [];
                    }
                } else if (line.startsWith("data:")) {
                    data.push(line.slice(5).replace(/^ /, ""));
                }
                end = SSE_LINE_END.exec(pending);
            }
            if (chunk.done) {
                return;
            }
        }
    } finally {
        try {
            await reader.cancel();
        } finally {
            reader.releaseLock();
        }
    }
}

async function accumulateResponsesJson(
    stream: ReadableStream<Uint8Array>,
    itemScope: string
): Promise<{ failed: false; body: string } | { failed: true; error: string; errorCode?: string }> {
    let text = "";
    const functionCalls: unknown[] = [];
    const reasoningItems: unknown[] = [];
    // A hosted web search: its calls (query and sources) and the answer's url_citation annotations.
    const searchCalls: unknown[] = [];
    const annotations: unknown[] = [];
    let completed: Record<string, unknown> | undefined;
    let failure: string | undefined;
    let failureCode: string | undefined;

    for await (const payload of whamSsePayloads(stream)) {
        if (payload.length === 0 || payload === "[DONE]") {
            continue;
        }

        let event: unknown;
        try {
            event = SafeJSON.parse(payload, { strict: true });
        } catch (err) {
            logger.debug({ err }, "ai-proxy: WHAM SSE event parse failed");
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

        if (
            event.type === "response.output_item.done" &&
            isObject(event.item) &&
            event.item.type === "web_search_call"
        ) {
            searchCalls.push(event.item);
            continue;
        }

        if (event.type === "response.output_text.annotation.added" && isObject(event.annotation)) {
            annotations.push(event.annotation);
            continue;
        }

        // Reasoning items (summary + encrypted_content) are what a Responses
        // client replays next turn. The rebuild dropped them, so a non-streaming
        // caller could never continue its own reasoning.
        if (event.type === "response.output_item.done" && isObject(event.item) && event.item.type === "reasoning") {
            reasoningItems.push(event.item);
            continue;
        }

        if (event.type === "response.completed" && isObject(event.response) && event.response.status === "completed") {
            completed = event.response;
            continue;
        }

        if (event.type === "response.incomplete") {
            failure = "WHAM response.incomplete";
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

    if (!completed) {
        return { failed: true, error: "WHAM stream ended before response.completed" };
    }

    const output: unknown[] = [];

    for (const item of reasoningItems) {
        if (isObject(item) && typeof item.id !== "string") {
            output.push({ ...item, id: `rs_${randomUUID().replace(/-/g, "")}` });
            continue;
        }

        output.push(item);
    }

    output.push(...searchCalls);

    if (text.length > 0) {
        // Responses API clients (Vercel AI SDK) require an id on every output item; WHAM omits it.
        output.push({
            id: `msg_${randomUUID().replace(/-/g, "")}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations }],
        });
    }

    for (const call of functionCalls) {
        if (isObject(call) && typeof call.id !== "string") {
            output.push({ ...call, id: `fc_${randomUUID().replace(/-/g, "")}` });
            continue;
        }

        output.push(call);
    }

    for (const item of output) {
        // Responses clients chain the next turn by item_reference id; the proxy
        // is the store those references resolve against.
        rememberWhamOutputItem(itemScope, item);
    }

    return { failed: false, body: SafeJSON.stringify({ ...completed, object: "response", output }) };
}

function jsonError(status: number, message: string): Response {
    return new Response(SafeJSON.stringify({ error: { message } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** OpenAI-shaped error response for a failed WHAM request that is not about the account. */
function whamErrorResponse({ status, bodyText }: { status: number; bodyText: string }): Response {
    return new Response(SafeJSON.stringify(mapWhamError({ status, bodyText })), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
