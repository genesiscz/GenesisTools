import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { clientAbortResponse } from "@app/ai-proxy/lib/providers/client-abort";
import { relayHeaders } from "@app/ai-proxy/lib/providers/http-relay";
import type { OpenAiModel, ProviderInspectionOptions, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import {
    anthropicMessageToOpenAiCompletion,
    anthropicSseToOpenAiChatStream,
} from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-openai-completions";
import { toAnthropicErrorResponse } from "@app/ai-proxy/lib/translators/formats/anthropic/error-envelope";
import { hoistSystemMessages } from "@app/ai-proxy/lib/translators/formats/anthropic/hoist-system-messages";
import {
    type OpenAiChatBody,
    openAiChatToAnthropicMessages,
} from "@app/ai-proxy/lib/translators/formats/anthropic/openai-to-anthropic-messages";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import {
    ANTHROPIC_SUB_ALIASES,
    fetchAnthropicSubModels,
    resolveAnthropicSubModel,
} from "@genesiscz/utils/ai/anthropic/models";
import {
    type InferenceToken,
    recoverInferenceToken,
    resolveAccountToken,
    resolveInferenceToken,
} from "@genesiscz/utils/claude/subscription-auth";
import {
    applySystemPromptPrefix,
    createSubscriptionFetch,
    SUBSCRIPTION_BETAS,
    SUBSCRIPTION_SYSTEM_PREFIX,
} from "@genesiscz/utils/claude/subscription-billing";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const SYSTEM_ROLE_REJECTION = "role 'system' is not supported";

/** Concrete models that answered SYSTEM_ROLE_REJECTION in this process. */
const SYSTEM_ROLE_REJECTED = new Set<string>();

/**
 * Bills the owner's Claude Max/Pro subscription. Speaks OpenAI to proxy
 * clients, forwards the Claude Code spoof (Bearer OAuth token + billing header
 * + beta flags) to api.anthropic.com/v1/messages, and maps responses back.
 */
/**
 * Union of the subscription's required betas and whatever the client asked for.
 *
 * Order-preserving and deduped: the subscription flags must stay present (OAuth
 * depends on them), and the client's flags decide whether its own request fields
 * are even legal upstream.
 */
export function mergeBetas(required: string, client?: string | null): string {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const value of [required, client ?? ""]) {
        for (const beta of value.split(",")) {
            const trimmed = beta.trim();

            if (trimmed.length > 0 && !seen.has(trimmed)) {
                seen.add(trimmed);
                out.push(trimmed);
            }
        }
    }

    return out.join(",");
}

/**
 * Add the subscription system prefix WITHOUT flattening the caller's system.
 *
 * Claude Code sends `system` as an array of blocks carrying `cache_control`,
 * and collapsing it to a string is what destroyed prompt caching on this path:
 * Anthropic caches only at explicit breakpoints, so a stringified system has
 * none and every turn re-reads the whole prompt at full price.
 *
 * Claude Code's own system[0] already IS this exact prefix, so the common case
 * is a no-op and the array is forwarded byte-identical.
 */
export function ensureSubscriptionSystemPrefix(system: unknown): unknown {
    if (system === undefined || system === null) {
        return SUBSCRIPTION_SYSTEM_PREFIX;
    }

    if (typeof system === "string") {
        return system.startsWith(SUBSCRIPTION_SYSTEM_PREFIX)
            ? system
            : applySystemPromptPrefix(SUBSCRIPTION_SYSTEM_PREFIX, system);
    }

    if (!Array.isArray(system)) {
        return system;
    }

    const first = system[0];
    const firstText = isObject(first) && typeof first.text === "string" ? first.text : "";

    if (firstText.startsWith(SUBSCRIPTION_SYSTEM_PREFIX)) {
        return system;
    }

    return [{ type: "text", text: SUBSCRIPTION_SYSTEM_PREFIX }, ...system];
}

export class AnthropicSubscriptionProvider implements ProxyProvider {
    readonly id = "anthropic-subscription";
    readonly accountFingerprint: string;
    private readonly account: AiProxyAccountConfig;
    /** Name of the anthropic-sub account (in ~/.genesis-tools/ai/config.json) whose token is billed. */
    private readonly billingAccountName: string;
    private readonly upstreamFetch: typeof fetch;

    constructor(account: AiProxyAccountConfig) {
        this.account = account;
        this.accountFingerprint = accountConfigFingerprint(account);
        this.billingAccountName = account.anthropicSub?.accountName ?? account.name;
        this.upstreamFetch = createSubscriptionFetch();
    }

    static async create(account: AiProxyAccountConfig): Promise<AnthropicSubscriptionProvider> {
        return new AnthropicSubscriptionProvider(account);
    }

    async listModels(options?: ProviderInspectionOptions): Promise<OpenAiModel[]> {
        const aliases: OpenAiModel[] = ANTHROPIC_SUB_ALIASES.map((alias) => ({
            id: `${this.account.name}/${this.account.providerSlug}/${alias}`,
            object: "model",
            created: 1_740_960_000,
            owned_by: "anthropic",
            description: `Claude ${alias} via subscription (${resolveAnthropicSubModel(alias)})`,
        }));

        const { token } = await resolveAccountToken(this.billingAccountName, { noRefresh: options?.probe });
        const records = await fetchAnthropicSubModels(token);

        return [
            ...aliases,
            ...records.map((record) => ({
                id: `${this.account.name}/${this.account.providerSlug}/${record.id}`,
                object: "model" as const,
                created: 1_740_960_000,
                owned_by: "anthropic",
                description: `${record.displayName} via subscription`,
            })),
        ];
    }

    async chatCompletions(req: Request, model: string, bodyText: string): Promise<Response> {
        const proxyModelId = `${this.account.name}/${this.account.providerSlug}/${model}`;
        const concreteModel = resolveAnthropicSubModel(model);

        let openAiBody: OpenAiChatBody;
        try {
            const parsedBody = SafeJSON.parse(bodyText, { strict: true });
            if (!isObject(parsedBody)) {
                return jsonError(400, "Invalid JSON body");
            }

            openAiBody = parsedBody as OpenAiChatBody;
        } catch (err) {
            logger.debug({ err }, "ai-proxy: anthropic-subscription got invalid JSON body");
            return jsonError(400, "Invalid JSON body");
        }

        const streaming = openAiBody.stream === true;
        const anthropicBody = openAiChatToAnthropicMessages(openAiBody, { model: concreteModel });
        anthropicBody.system = applySystemPromptPrefix(SUBSCRIPTION_SYSTEM_PREFIX, anthropicBody.system ?? "");

        const upstream = await this.forwardAnthropic({ anthropicBody, req, concreteModel, proxyModelId, streaming });

        if (!upstream.ok) {
            return upstream;
        }

        if (streaming) {
            if (!upstream.body) {
                return jsonError(502, "Anthropic upstream returned no stream body");
            }

            return new Response(anthropicSseToOpenAiChatStream(upstream.body, { model: proxyModelId }), {
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
                },
            });
        }

        const message = (await upstream.json()) as Record<string, unknown>;
        const completion = anthropicMessageToOpenAiCompletion(message, { model: proxyModelId });

        return new Response(SafeJSON.stringify(completion), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }

    /**
     * POST an already-Anthropic body upstream: resolve the subscription token,
     * retry once on 401, and hand back the raw upstream Response.
     *
     * Shared so the OpenAI-facing door and the native /v1/messages passthrough
     * cannot drift on auth, retry or error handling.
     */
    private async forwardAnthropic({
        anthropicBody,
        req,
        concreteModel,
        proxyModelId,
        streaming,
        clientBetas,
    }: {
        anthropicBody: unknown;
        req: Request;
        concreteModel: string;
        proxyModelId: string;
        streaming: boolean;
        /** Betas the CLIENT asked for, merged with the subscription's own. */
        clientBetas?: string | null;
    }): Promise<Response> {
        const started = performance.now();
        let token: InferenceToken;
        try {
            token = await resolveInferenceToken(this.billingAccountName);
        } catch (err) {
            logger.warn(
                { err, account: this.account.name, billingAccount: this.billingAccountName },
                "ai-proxy: anthropic-subscription token resolution failed"
            );
            return jsonError(
                502,
                `Anthropic subscription token unavailable: ${err instanceof Error ? err.message : String(err)}`
            );
        }

        const callUpstream = (bearer: string): Promise<Response> =>
            this.upstreamFetch(ANTHROPIC_MESSAGES_URL, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "anthropic-version": ANTHROPIC_VERSION,
                    "anthropic-beta": mergeBetas(SUBSCRIPTION_BETAS, clientBetas),
                    Authorization: `Bearer ${bearer}`,
                    Accept: streaming ? "text/event-stream" : "application/json",
                },
                body: SafeJSON.stringify(anthropicBody),
                signal: req.signal,
            });

        let upstream: Response;
        try {
            upstream = await callUpstream(token.token);

            // A long-running proxy can hold a revoked-but-unexpired token:
            // another process rotating the OAuth chain revokes our cached
            // access token while `expiresAt` still looks valid, so the fast
            // path in resolveAccountToken never re-reads disk. On 401, recover
            // once (a rejected long-lived token falls back to the OAuth pair, a
            // rejected access token is force-refreshed) and retry.
            if (upstream.status === 401) {
                logger.warn(
                    { account: this.account.name, billingAccount: this.billingAccountName, kind: token.kind },
                    "ai-proxy: anthropic upstream 401 — recovering the subscription token and retrying once"
                );
                token = await recoverInferenceToken(this.billingAccountName, token);
                upstream = await callUpstream(token.token);
            }
        } catch (err) {
            const aborted = clientAbortResponse(err, { err, account: this.account.name, model: concreteModel });
            if (aborted) {
                return aborted;
            }

            logger.warn(
                { err, account: this.account.name, model: concreteModel },
                "ai-proxy: anthropic upstream fetch failed"
            );
            return jsonError(
                502,
                `Failed to reach Anthropic upstream: ${err instanceof Error ? err.message : String(err)}`
            );
        }

        const elapsedMs = Math.round(performance.now() - started);

        if (!upstream.ok) {
            const errorText = await upstream.text();
            logger.warn(
                {
                    account: this.account.name,
                    upstreamModel: concreteModel,
                    requestedModel: proxyModelId,
                    status: upstream.status,
                    elapsedMs,
                    body: errorText.slice(0, 500),
                },
                "ai-proxy: anthropic upstream request failed"
            );

            return new Response(errorText, {
                status: upstream.status,
                headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
            });
        }

        logger.debug(
            {
                account: this.account.name,
                upstreamModel: concreteModel,
                requestedModel: proxyModelId,
                streaming,
                elapsedMs,
            },
            "ai-proxy: anthropic upstream request ok"
        );

        return upstream;
    }

    /**
     * Native `/v1/messages` passthrough: the client already speaks Anthropic and
     * so does this upstream, so the body is forwarded essentially verbatim.
     *
     * Reshaping through the OpenAI schema in between dropped every field OpenAI
     * has no slot for. `cache_control` was the expensive one: two identical
     * 36,958-token Claude Code requests both reported `cache_read: none`,
     * because Anthropic caches ONLY at explicit breakpoints. This path keeps
     * them, along with thinking signatures and exact tool schemas.
     */
    async messages(req: Request, model: string, bodyText: string): Promise<Response> {
        const proxyModelId = `${this.account.name}/${this.account.providerSlug}/${model}`;
        const concreteModel = resolveAnthropicSubModel(model);

        let parsed: Record<string, unknown>;
        try {
            const raw = SafeJSON.parse(bodyText, { strict: true });

            if (!isObject(raw)) {
                return jsonError(400, "Invalid JSON body");
            }

            parsed = raw;
        } catch (err) {
            logger.debug({ err }, "ai-proxy: anthropic-subscription got invalid JSON body");
            return jsonError(400, "Invalid JSON body");
        }

        const forward = (body: Record<string, unknown>): Promise<Response> => {
            const anthropicBody: Record<string, unknown> = {
                ...body,
                model: concreteModel,
                system: ensureSubscriptionSystemPrefix(body.system),
            };

            // The recall quest's mode B (AI_PROXY_REASONING_REPLAY=drop): earlier turns go up without their thinking.
            if (env.aiProxy.getReasoningReplay() === "drop" && Array.isArray(body.messages)) {
                anthropicBody.messages = withoutEarlierThinking(body.messages);
            }

            return this.forwardAnthropic({
                anthropicBody,
                req,
                concreteModel,
                proxyModelId,
                streaming: parsed.stream === true,
                // Without this the passthrough 400s on the client's own fields:
                // Claude Code sends `context_management`, and Anthropic rejects it
                // unless context-management-2025-06-27 is advertised.
                clientBetas: req.headers.get("anthropic-beta"),
            });
        };

        // Claude Code puts hook output in a role:"system" entry inside messages[],
        // and the turn's cache breakpoint often sits on it. Opus 4.8 and newer
        // take it in place (probed 2026-10-26). Hoisting it into system[] took
        // that breakpoint off the history, so every turn sent the whole
        // conversation uncached (62.5% hit in a 4-turn session). Older models
        // (Opus 4.7, Sonnet 4.6, Haiku 4.5) answer 400 `role 'system' is not
        // supported on this model`: only then is it hoisted, and the model is
        // remembered so later requests hoist at once.
        const hoisted = hoistSystemMessages(parsed);

        if (SYSTEM_ROLE_REJECTED.has(concreteModel)) {
            return this.messagesResponse(await forward(hoisted));
        }

        let upstream = await forward(parsed);

        if (upstream.status === 400 && hoisted !== parsed) {
            const errorText = await upstream.clone().text();

            if (errorText.includes(SYSTEM_ROLE_REJECTION)) {
                SYSTEM_ROLE_REJECTED.add(concreteModel);
                logger.info(
                    { model: concreteModel },
                    "ai-proxy: model rejects role:system in messages, hoisting it into system[]"
                );
                upstream = await forward(hoisted);
            }
        }

        return this.messagesResponse(upstream);
    }

    private async messagesResponse(upstream: Response): Promise<Response> {
        // forwardAnthropic's OWN failures (token unavailable, client abort)
        // carry OpenAI-shaped or plain-text bodies; an Anthropic client checks
        // `type === "error"` first and rendered a blank failure. Real upstream
        // errors are already Anthropic-shaped and pass through unchanged.
        if (!upstream.ok) {
            return toAnthropicErrorResponse(upstream);
        }

        // Bun's fetch already decoded the body but left content-encoding on the
        // headers. Relaying them verbatim makes the client try to brotli-decode
        // plain bytes — the live flow-matrix test failed with
        // BrotliDecompressionError the first time this path ran end to end.
        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: relayHeaders(upstream),
        });
    }

    async responses(_req: Request, _model: string, _bodyText: string): Promise<Response> {
        // The Claude subscription upstream has no Responses API. Clients should
        // use /v1/chat/completions for anthropic-subscription models. (Cursor
        // request translation is disabled for this provider — see
        // shouldTranslateChatRequest — so this path is not hit in normal flows.)
        return jsonError(
            400,
            "anthropic-subscription does not support the Responses API — use POST /v1/chat/completions with this model."
        );
    }

    async getUsage(): Promise<UsageSummary> {
        return {
            accountName: this.account.name,
            provider: "anthropic-subscription",
            summary: "subscription (usage not exposed by the Anthropic OAuth API)",
        };
    }
}

/**
 * The messages with no thinking from earlier turns. The current turn (from the last user message that is not only
 * tool results) keeps its thinking, which Anthropic requires while a tool loop runs.
 */
export function withoutEarlierThinking(messages: unknown[]): unknown[] {
    const isTurnStart = (message: unknown): boolean =>
        isObject(message) &&
        message.role === "user" &&
        (typeof message.content === "string" ||
            (Array.isArray(message.content) &&
                message.content.some((block) => !(isObject(block) && block.type === "tool_result"))));
    const turnStart = messages.findLastIndex(isTurnStart);

    return messages.map((message, index) => {
        if (
            index >= turnStart ||
            !isObject(message) ||
            message.role !== "assistant" ||
            !Array.isArray(message.content)
        ) {
            return message;
        }

        const kept = message.content.filter(
            (block) => !(isObject(block) && (block.type === "thinking" || block.type === "redacted_thinking"))
        );
        return { ...message, content: kept.length > 0 ? kept : [{ type: "text", text: "(reasoning dropped)" }] };
    });
}

function jsonError(status: number, message: string): Response {
    return new Response(SafeJSON.stringify({ error: { message } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
