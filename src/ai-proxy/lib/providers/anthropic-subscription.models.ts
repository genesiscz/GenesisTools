import type { CatalogOptions } from "@app/ai-proxy/lib/providers/definition";
import { providerKey } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import {
    ANTHROPIC_SUB_ALIASES,
    ANTHROPIC_SUB_STATIC_CATALOG,
    type AnthropicSubModelRecord,
    inferAnthropicContextWindow,
    resolveAnthropicSubModel,
    tryFetchAnthropicSubModels,
} from "@genesiscz/utils/ai/anthropic/models";
import { byId, isDatedModelId } from "@genesiscz/utils/ai/catalog";
import { toProxyId } from "@genesiscz/utils/ai/grok";
import { resolveAccountToken } from "@genesiscz/utils/claude/subscription-auth";
import { logger } from "@genesiscz/utils/logger";

export const ANTHROPIC_MESSAGES_BASE_URL = "https://api.anthropic.com/v1";

/**
 * Claude subscription catalog for the proxy model list.
 *
 * Prefers live GET api.anthropic.com/v1/models (same as accounts test). That is
 * availability for Claude — not a per-id chat "probe" like Grok. On failure,
 * falls back to the static catalog with probeStatus=skip.
 */
export async function listAnthropicSubProxyModels(
    account: AiProxyAccountConfig,
    options?: CatalogOptions
): Promise<ProxyModelMeta[]> {
    let records: AnthropicSubModelRecord[] = ANTHROPIC_SUB_STATIC_CATALOG;
    let source: ProxyModelMeta["source"] = "static";
    let probeStatus: ProxyModelMeta["probeStatus"] = "skipped";

    try {
        const billingName = account.anthropicSub?.accountName ?? account.name;
        const { token } = await resolveAccountToken(billingName, { noRefresh: options?.probe });
        const live = await tryFetchAnthropicSubModels(token);

        if (live && live.length > 0) {
            records = live;
            source = "api-catalog";
            probeStatus = "ok";
        } else {
            logger.debug({ account: account.name }, "ai-proxy: anthropic catalog static fallback");
        }
    } catch (err) {
        logger.debug({ err, account: account.name }, "ai-proxy: anthropic catalog auth/list failed — static fallback");
    }

    const shared = (upstreamId: string) => ({
        proxyId: toProxyId(account.name, account.providerSlug, upstreamId),
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId,
        provider: account.provider,
        baseUrl: ANTHROPIC_MESSAGES_BASE_URL,
        visibility: "high" as const,
        speed: "medium" as const,
        // Every current Claude model accepts text + images.
        inputModalities: ["text", "image"],
        supportsTools: true,
        billingPlane: "subscription" as const,
        source,
        probeStatus,
        object: "model" as const,
        created: 1_740_960_000,
        owned_by: providerKey(account),
    });

    // Short aliases always advertised; they resolve to the current family head.
    const aliases: ProxyModelMeta[] = ANTHROPIC_SUB_ALIASES.map((alias) => {
        const concrete = resolveAnthropicSubModel(alias);

        return {
            ...shared(alias),
            thinking: byId(concrete, "anthropic")?.thinking === "none" ? "none" : "reasoning",
            contextWindow: inferAnthropicContextWindow(concrete),
            description: `Claude ${alias} via subscription (${concrete})`,
        };
    });

    const concrete: ProxyModelMeta[] = records
        .filter((record) => !isDatedModelId(record.id))
        .map((record) => ({
            ...shared(record.id),
            thinking: record.thinking,
            contextWindow: record.contextWindow,
            description: `${record.displayName} via subscription`,
        }));

    return [...aliases, ...concrete];
}
