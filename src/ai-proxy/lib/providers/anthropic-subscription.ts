import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { clientAbortResponse } from "@app/ai-proxy/lib/providers/client-abort";
import { relayHeaders } from "@app/ai-proxy/lib/providers/http-relay";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
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
import { resolveAccountToken } from "@genesiscz/utils/claude/subscription-auth";
import {
    applySystemPromptPrefix,
    createSubscriptionFetch,
    SUBSCRIPTION_BETAS,
    SUBSCRIPTION_SYSTEM_PREFIX,
} from "@genesiscz/utils/claude/subscription-billing";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

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

    async listModels(): Promise<OpenAiModel[]> {
        const aliases: OpenAiModel[] = ANTHROPIC_SUB_ALIASES.map((alias) => ({
            id: `${this.account.name}/${this.account.providerSlug}/${alias}`,
            object: "model",
            created: 1_740_960_000,
            owned_by: "anthropic",
            description: `Claude ${alias} via subscription (${resolveAnthropicSubModel(alias)})`,
        }));

        const { token } = await resolveAccountToken(this.billingAccountName);
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
        let token: string;
        try {
            ({ token } = await resolveAccountToken(this.billingAccountName));
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
            upstream = await callUpstream(token);

            // A long-running proxy can hold a revoked-but-unexpired token:
            // another process rotating the OAuth chain revokes our cached
            // access token while `expiresAt` still looks valid, so the fast
            // path in resolveAccountToken never re-reads disk. On 401,
            // force-resolve once (fresh disk read + refresh if needed) and retry.
            if (upstream.status === 401) {
                logger.warn(
                    { account: this.account.name, billingAccount: this.billingAccountName },
                    "ai-proxy: anthropic upstream 401 — force-refreshing subscription token and retrying once"
                );
                ({ token } = await resolveAccountToken(this.billingAccountName, { forceRefresh: true }));
                upstream = await callUpstream(token);
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

        // Claude Code sometimes puts a role:"system" entry inside messages[];
        // Anthropic rejects it with `role 'system' is not supported on this
        // model` (verified live 2026-08-19), same class as grok's 400. Hoist
        // BEFORE the prefix fix-up so the subscription prefix stays system[0].
        // Hoisted blocks are appended after the existing system array, so
        // cache_control breakpoints on the existing prefix are untouched.
        const hoisted = hoistSystemMessages(parsed);

        const anthropicBody: Record<string, unknown> = {
            ...hoisted,
            model: concreteModel,
            system: ensureSubscriptionSystemPrefix(hoisted.system),
        };

        const upstream = await this.forwardAnthropic({
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

function jsonError(status: number, message: string): Response {
    return new Response(SafeJSON.stringify({ error: { message } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
