import { accountConfigFingerprint } from "@app/ai-proxy/lib/account-config";
import { ANTHROPIC_SUB_ALIASES, resolveAnthropicSubModel } from "@app/ai-proxy/lib/providers/anthropic-sub-models";
import type { OpenAiModel, ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import type { AiProxyAccountConfig, UsageSummary } from "@app/ai-proxy/lib/types";
import {
    anthropicMessageToOpenAiCompletion,
    anthropicSseToOpenAiChatStream,
} from "@app/ai-proxy/lib/translators/formats/anthropic/anthropic-to-openai-completions";
import {
    type OpenAiChatBody,
    openAiChatToAnthropicMessages,
} from "@app/ai-proxy/lib/translators/formats/anthropic/openai-to-anthropic-messages";
import { logger } from "@app/logger";
import { resolveAccountToken } from "@app/utils/claude/subscription-auth";
import {
    applySystemPromptPrefix,
    createSubscriptionFetch,
    SUBSCRIPTION_BETAS,
    SUBSCRIPTION_SYSTEM_PREFIX,
} from "@app/utils/claude/subscription-billing";
import { SafeJSON } from "@app/utils/json";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Bills the owner's Claude Max/Pro subscription. Speaks OpenAI to proxy
 * clients, forwards the Claude Code spoof (Bearer OAuth token + billing header
 * + beta flags) to api.anthropic.com/v1/messages, and maps responses back.
 */
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
        return ANTHROPIC_SUB_ALIASES.map((alias) => ({
            id: `${this.account.name}/${this.account.providerSlug}/${alias}`,
            object: "model",
            created: 1_740_960_000,
            owned_by: "anthropic",
            description: `Claude ${alias} via subscription (${resolveAnthropicSubModel(alias)})`,
        }));
    }

    async chatCompletions(req: Request, model: string, bodyText: string): Promise<Response> {
        const proxyModelId = `${this.account.name}/${this.account.providerSlug}/${model}`;
        const concreteModel = resolveAnthropicSubModel(model);

        let openAiBody: OpenAiChatBody;
        try {
            openAiBody = SafeJSON.parse(bodyText, { strict: true }) as OpenAiChatBody;
        } catch (err) {
            logger.debug({ err }, "ai-proxy: anthropic-subscription got invalid JSON body");
            return jsonError(400, "Invalid JSON body");
        }

        const streaming = openAiBody.stream === true;
        const anthropicBody = openAiChatToAnthropicMessages(openAiBody, { model: concreteModel });
        anthropicBody.system = applySystemPromptPrefix(SUBSCRIPTION_SYSTEM_PREFIX, anthropicBody.system ?? "");

        let token: string;
        try {
            ({ token } = await resolveAccountToken(this.billingAccountName));
        } catch (err) {
            logger.warn(
                { err, account: this.account.name, billingAccount: this.billingAccountName },
                "ai-proxy: anthropic-subscription token resolution failed"
            );
            return jsonError(502, `Anthropic subscription token unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }

        const started = performance.now();
        const upstream = await this.upstreamFetch(ANTHROPIC_MESSAGES_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "anthropic-version": ANTHROPIC_VERSION,
                "anthropic-beta": SUBSCRIPTION_BETAS,
                Authorization: `Bearer ${token}`,
                Accept: streaming ? "text/event-stream" : "application/json",
            },
            body: SafeJSON.stringify(anthropicBody),
            signal: req.signal,
        });

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
            { account: this.account.name, upstreamModel: concreteModel, requestedModel: proxyModelId, streaming, elapsedMs },
            "ai-proxy: anthropic upstream request ok"
        );

        if (streaming) {
            if (!upstream.body) {
                return jsonError(502, "Anthropic upstream returned no stream body");
            }

            return new Response(anthropicSseToOpenAiChatStream(upstream.body, { model: proxyModelId }), {
                status: 200,
                headers: {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
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
