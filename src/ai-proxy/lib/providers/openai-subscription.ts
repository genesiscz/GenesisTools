import { randomUUID } from "node:crypto";
import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { codexModelInfo } from "@app/ai-proxy/lib/codex-catalog";
import { captureUpstreamFailure } from "@app/ai-proxy/lib/debug-capture";
import { jsonError } from "@app/ai-proxy/lib/http-error";
import { clientAbortResponse } from "@app/ai-proxy/lib/providers/client-abort";
import {
    CodexCompactionFlow,
    CompactionRestoreError,
    compactionDispatch,
    type FailureClient,
    fileCompactionStore,
    inputHasFallback,
} from "@app/ai-proxy/lib/providers/codex/compaction-flow";
import { execToolBridge } from "@app/ai-proxy/lib/providers/codex/exec/tool";
import {
    buildWhamResponsesBody,
    contentHash,
    hasReasoningInput,
    nonStrictByDefault,
    reasoningOptions,
    resolveWhamReasoning,
    warnDroppedParamsOnce,
} from "@app/ai-proxy/lib/providers/codex/wham-body";
import {
    accumulateResponsesJson,
    tapCompletedUsage,
    whamErrorResponse,
} from "@app/ai-proxy/lib/providers/codex/wham-stream";
import { cooldownRemainingMs, markRateLimited, markSuccess, markUnhealthy } from "@app/ai-proxy/lib/providers/cooldown";
import { relayHeaders } from "@app/ai-proxy/lib/providers/http-relay";
import { resolveOpenAiSubFailoverToken, resolveOpenAiSubToken } from "@app/ai-proxy/lib/providers/openai-sub-token";
import { rememberedMessageItems, rememberMessageItems } from "@app/ai-proxy/lib/providers/reasoning-memory";
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
import { parseRetryAfterSeconds } from "@app/ai-proxy/lib/providers/wham-errors";
import { createWhamItemHarvestTransform, whamItemScope } from "@app/ai-proxy/lib/providers/wham-item-store";
import {
    braveSearchFn,
    type EmulationOutcome,
    emulateWebSearch,
    nativeTranslationLoss,
    nativeWebSearch,
    parseWebSearchServerTool,
    unsupportedNativeResponse,
    type WebSearchServerTool,
    webSearchResponse,
} from "@app/ai-proxy/lib/server-tools/web-search";
import {
    compactionPoint,
    shouldStartBackground,
    takePendingNotice,
    trackBackground,
    withUserReminder,
} from "@app/ai-proxy/lib/sessions/background-compaction";
import {
    cacheResetNotice,
    cacheResetReason,
    preserveCacheReminders,
    shapeChange,
} from "@app/ai-proxy/lib/sessions/cache-shape";
import {
    compactionMarkers,
    compactionRecoveryMessage,
    expandCompactionMarkers,
} from "@app/ai-proxy/lib/sessions/codex-compaction";
import { CompactionTrace } from "@app/ai-proxy/lib/sessions/compaction-events";
import { loginAccountName, noteBlockedCompaction, readSessionRecord } from "@app/ai-proxy/lib/sessions/records";
import { compactionPolicy } from "@app/ai-proxy/lib/sessions/settings";
import {
    anthropicToResponses,
    stripReasoningInput,
} from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-responses";
import {
    CLAUDE_CODE_AGENT_TOOL,
    ClaudeCodeTurn,
    sessionAgentModelWins,
} from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import { ensureToolRequiredArrays } from "@app/ai-proxy/lib/translators/formats/anthropic/ensure-tool-required";
import { toAnthropicErrorResponse } from "@app/ai-proxy/lib/translators/formats/anthropic/error-envelope";
import {
    MAX_REPLAY_RESPONSE_CHARS,
    responsesSseToAnthropic,
    responsesToAnthropicMessage,
} from "@app/ai-proxy/lib/translators/formats/anthropic/grok-responses-to-anthropic";
import { codexReasoningCodec } from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-codec";
import {
    accountHash8,
    isReasoningReplayRejection,
    type ReasoningEnvelopeStamp,
} from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-envelope";
import { responsesToChat } from "@app/ai-proxy/lib/translators/responses-to-chat";
import type { AiProxyAccountConfig, ThinkingPresentationMode, UsageSummary } from "@app/ai-proxy/lib/types";
import { notePrefix, setPrefixDiff } from "@app/ai-proxy/lib/usage/prefix-diff";
import { getTodayUsageSummary, getUsageSummarySince, recordUsageRequest } from "@app/ai-proxy/lib/usage/store";
import { extractPlanType, WHAM_BASE_URL } from "@genesiscz/utils/ai/openai/codex-auth";
import {
    fetchWhamModels,
    resolveOpenAiSubModel,
    tryFetchWhamModels,
    type WhamModelRecord,
} from "@genesiscz/utils/ai/openai/sub-models";
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

    /** Claude Code's compaction on this provider's logins: native, background and the item per login. */
    private readonly compaction: CodexCompactionFlow;

    constructor(account: AiProxyAccountConfig) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
        this.compaction = new CodexCompactionFlow({
            upstream: (req, model, body, client) => this.respond(req, model, body, client),
            writtenSummary: (req, model, bodyText, context) => this.nativeMessages(req, model, bodyText, context, true),
            store: fileCompactionStore,
            usage: recordUsageRequest,
            account: account.name,
            provider: this.id,
        });

        if (env.aiProxy.getCodexMessagesRoute() === "responses") {
            this.messages = (req, model, bodyText, context) => {
                let parsed: unknown;
                try {
                    parsed = SafeJSON.parse(bodyText, { strict: true });
                } catch (error) {
                    logger.debug({ error }, "ai-proxy: could not inspect the messages body for compaction");
                    return this.nativeMessages(req, model, bodyText, context);
                }

                if (!isObject(parsed) || !ClaudeCodeTurn.read(parsed).isCompaction) {
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
        const codec = codexReasoningCodec(stamp);
        const replay = {
            kept: [] as string[],
            restored: 0,
            dropped: {} as Record<string, number>,
        };
        const turn = ClaudeCodeTurn.read(parsed);
        // Content-derived cache keys are not conversation identities.
        const conversationId =
            context?.promptCacheKey?.source === "content"
                ? (turn.sessionId ?? context?.sessionId)
                : (context?.promptCacheKey?.key ?? turn.sessionId ?? context?.sessionId);
        const conversation = conversationId
            ? `${whamItemScope(req)}\u0000${conversationId}\u0000${stamp.accountHash}\u0000${stamp.compHash}`
            : undefined;
        const compaction = turn.isCompaction;
        // The compaction settings, read once: a config reload during the request cannot change its path midway.
        const policy = compactionPolicy("codex", context?.sessionsIn);
        const background = policy.background;
        const nativeCompaction = compaction && !writtenCompaction && policy.mode === "native";
        const summaryWords = compaction && !nativeCompaction ? policy.words : undefined;
        const claudeSessionId = turn.sessionId;
        const cacheScope = `${whamItemScope(req)}\u0000${stamp.accountHash}\u0000${conversationId ?? claudeSessionId ?? ""}`;
        const cacheThread = `${cacheScope}\u0000${turn.threadKey ?? claudeSessionId ?? ""}`;
        const clientAgent = req.headers.get("user-agent") ?? undefined;
        const trace = new CompactionTrace({
            ...(context?.sessionId ? { session: context.sessionId } : {}),
            ...(claudeSessionId ? { claudeSession: claudeSessionId } : {}),
            model: concreteModel,
            ...(clientAgent ? { client: clientAgent } : {}),
        });

        // Background compaction runs only for a ccx session, whose record knows where Claude Code will compact.
        const point = compactionPoint(context?.sessionId ? readSessionRecord(context.sessionId) : undefined);
        const threadKey = point && background.enabled ? turn.threadKey : undefined;

        if (threadKey) {
            trace.setThread(threadKey.slice(threadKey.lastIndexOf(":") + 1, threadKey.lastIndexOf(":") + 9));
        }

        if (compaction && !writtenCompaction) {
            trace.record("turn", { mode: nativeCompaction ? "native" : "summary" });

            if (turn.isCompactionRetry) {
                trace.record("retry", {
                    reason: "Claude Code asked for the summary again: the last reply had no <summary> tag",
                });
            }
        }

        if (nativeCompaction) {
            // The server compacts what came before; Claude Code's summary prompt would only end the cached prefix.
            parsed = turn.withoutCompactionPrompt();
        }

        if (summaryWords) {
            parsed = turn.withSummaryLimit(summaryWords);
        }

        // Codex's `exec` rides on Claude Code's Bash: offered when the client has Bash, replayed as the model made it.
        const exec = execToolBridge({ tools: parsed.tools, sessionsIn: context?.sessionsIn });

        // System messages stay in place (`appendDeveloperMessage`): hoisted, they broke the prompt cache.
        let responsesBody = anthropicToResponses(ensureToolRequiredArrays(parsed), concreteModel, {
            // A Read of an image comes back as a tool result; WHAM takes it as input_image (codex-rs does the same).
            toolResultImages: true,
            // A change of `tools` reads 0% of the WHAM cache, so tool search's loads go in as input items.
            deferredToolsAsInput: true,
            deferredRecoveryScope: conversationId ? cacheThread : undefined,
            reasoningItem: (thinking) => {
                const opened = codec.open(thinking);

                if (!opened.ok || this.deadReasoning.has(String(opened.item.id))) {
                    const reason = opened.ok ? "dead" : opened.reason;
                    replay.dropped[reason] = (replay.dropped[reason] ?? 0) + 1;
                    return undefined;
                }

                replay.kept.push(contentHash(String(opened.item.encrypted_content)));
                return opened.item;
            },
            // Claude Code leaves earlier thinking out of a turn's first request; the same items keep the cache.
            restoreAssistantItems: (content) => {
                const items = conversation ? rememberedMessageItems(conversation, content) : undefined;

                if (!items || items.some((item) => this.deadReasoning.has(String(item.id)))) {
                    return undefined;
                }

                replay.restored += items.filter((item) => item.type === "reasoning").length;
                return items;
            },
            rememberAssistantItems: (content, items) => {
                if (conversation) {
                    rememberMessageItems(conversation, content, items);
                }
            },
            ...(exec ? { customToolCall: exec.replayItem } : {}),
        });

        if (Array.isArray(responsesBody.tools)) {
            responsesBody.tools = responsesBody.tools.map((tool) => (isObject(tool) ? nonStrictByDefault(tool) : tool));
        }

        // Last, after the function tools got `strict: false`: a custom tool has no `strict`.
        if (exec) {
            responsesBody.tools = [...(Array.isArray(responsesBody.tools) ? responsesBody.tools : []), exec.definition];
        }

        for (const item of Array.isArray(responsesBody.input) ? responsesBody.input : []) {
            if (isObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
                item.tools = item.tools.map((tool) => (isObject(tool) ? nonStrictByDefault(tool) : tool));
            }
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
        const clientEffort = turn.effort ?? "";
        // A compaction turn writes a summary of what is already known: the session's xhigh only made it slower (6 to 8
        // minutes per compaction on 2026-10-27), so it runs at the compaction effort when the model has that effort.
        const compactionEffort = compaction && !nativeCompaction ? policy.effort : undefined;
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

        const resolvedReasoning = resolveWhamReasoning(responsesBody, concreteModel, {
            defaultReasoningEffort: this.account.openaiSub?.defaultReasoningEffort,
            catalog,
        });
        const effectiveEffort = String(resolvedReasoning.reasoning?.effort ?? "");

        // Codex keeps one cache per effort and model: say so where the cache was lost. A compaction turn is its own case.
        const cacheReset =
            claudeSessionId && !compaction
                ? shapeChange(cacheThread, {
                      effort: effectiveEffort,
                      model: concreteModel,
                  })
                : undefined;

        if (cacheReset) {
            trace.record("cache-reset", { reason: cacheResetReason(cacheReset) });
        }

        if (claudeSessionId && Array.isArray(responsesBody.input)) {
            responsesBody.input = preserveCacheReminders(
                cacheThread,
                responsesBody.input,
                cacheReset ? cacheResetNotice(cacheReset) : undefined
            );
        }

        logger.debug(
            {
                model: concreteModel,
                replayed: replay.kept.length,
                replayedHashes: replay.kept,
                restored: replay.restored > 0 ? replay.restored : undefined,
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
                                return await this.compaction.compactionItem({
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

                trace.record("blocked", { id: error.marker, reason: error.message });

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
                const answered = await this.compaction.answerFromBackground({
                    key: threadKey,
                    point,
                    rawInput,
                    accountHash: stamp.accountHash,
                    model,
                    stream: parsed.stream === true,
                    trace,
                    startedAt,
                    settings: background,
                });

                if (answered.response) {
                    return answered.response;
                }

                notice = answered.notice;
            }

            return this.compaction.compactNatively({
                req,
                model,
                bodyText,
                context,
                parsed,
                responsesBody,
                rawInput,
                stamp,
                client,
                trace,
                startedAt,
                notice,
                threadKey,
            });
        }

        const pending = threadKey ? takePendingNotice(threadKey) : undefined;

        if (pending && Array.isArray(responsesBody.input)) {
            responsesBody = { ...responsesBody, input: withUserReminder(responsesBody.input, pending) };
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
                              this.compaction.runBackgroundCompaction({
                                  req,
                                  model,
                                  concreteModel,
                                  body: sentBody,
                                  rawInput,
                                  stamp,
                                  contextTokens,
                                  sessionId: context?.sessionId,
                                  trace,
                              }),
                              (unused, reason) =>
                                  trace.record("background-wasted", {
                                      reason,
                                      inputTokens: unused.inputTokens,
                                      cachedTokens: unused.cachedTokens,
                                      outputTokens: unused.outputTokens,
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

        // Where this request first differs from the thread's previous one: the ledger row names a miss's cause.
        if (claudeSessionId) {
            const firstUser = Array.isArray(parsed.messages)
                ? parsed.messages.find((message) => isObject(message) && message.role === "user")
                : undefined;
            const diagnosticThread = firstUser
                ? `${cacheScope}\u0000${claudeSessionId}\u0000${contentHash(SafeJSON.stringify(firstUser))}`
                : cacheThread;
            setPrefixDiff(
                req,
                notePrefix(diagnosticThread, {
                    model: concreteModel,
                    effort: effectiveEffort,
                    instructions: responsesBody.instructions,
                    tools: responsesBody.tools,
                    input: Array.isArray(responsesBody.input) ? responsesBody.input : [],
                })
            );
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
            // A failover login served this turn: its reasoning is its own, and the primary login could not decrypt it.
            const servedBy = client.servedIdentity;
            return servedBy
                ? codexReasoningCodec({ ...stamp, accountHash: accountHash8(servedBy) }).seal(item)
                : codec.seal(item);
        };

        const rememberTextResponse = (content: Record<string, unknown>[]): void => {
            if (!conversation || (client.servedIdentity && accountHash8(client.servedIdentity) !== stamp.accountHash)) {
                return;
            }
            let replayChars = content.length;
            for (const block of content) {
                for (const field of ["text", "thinking", "signature"]) {
                    if (typeof block[field] === "string") {
                        replayChars += block[field].length;
                    }
                }
                if (replayChars > MAX_REPLAY_RESPONSE_CHARS) {
                    return;
                }
            }
            try {
                const thinking = content.filter((block) => block.type === "thinking");
                if (
                    thinking.some((block) => {
                        const opened = codec.open(block);
                        return !opened.ok || this.deadReasoning.has(String(opened.item.id));
                    })
                ) {
                    return;
                }
                const translated = anthropicToResponses({ messages: [{ role: "assistant", content }] }, concreteModel, {
                    reasoningItem: (thinking) => {
                        const opened = codec.open(thinking);
                        return opened.ok && !this.deadReasoning.has(String(opened.item.id)) ? opened.item : undefined;
                    },
                });
                if (Array.isArray(translated.input)) {
                    rememberMessageItems(conversation, content, translated.input.filter(isObject));
                }
            } catch (error) {
                logger.warn({ error }, "ai-proxy: could not remember a completed reasoning reply");
            }
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
                    onTextResponse: conversation ? rememberTextResponse : undefined,
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
                    onTextResponse: conversation ? rememberTextResponse : undefined,
                    label: "codex",
                    toolInput,
                })
            ),
            { status: 200, headers: { "Content-Type": "application/json" } }
        );
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
