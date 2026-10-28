import type { CatalogOptions } from "@app/ai-proxy/lib/providers/definition";
import { resolveOpenAiSubToken } from "@app/ai-proxy/lib/providers/openai-sub-token";
import { providerKey } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { toProxyId } from "@genesiscz/utils/ai/grok";
import { WHAM_BASE_URL } from "@genesiscz/utils/ai/openai/codex-auth";
import {
    OPENAI_SUB_BUILTIN_ALIAS_NAMES,
    OPENAI_SUB_STATIC_CATALOG,
    resolveOpenAiSubModel,
    tryFetchWhamModels,
    type WhamModelRecord,
} from "@genesiscz/utils/ai/openai/sub-models";
import { logger } from "@genesiscz/utils/logger";

export const WHAM_RESPONSES_BASE_URL = WHAM_BASE_URL;

/**
 * Codex/ChatGPT catalog. Prefers live WHAM GET /models (plan-filtered).
 * That is the availability signal for Codex — not a chat probe.
 */
export async function listOpenAiSubProxyModels(
    account: AiProxyAccountConfig,
    options?: CatalogOptions
): Promise<ProxyModelMeta[]> {
    let records: WhamModelRecord[] = OPENAI_SUB_STATIC_CATALOG.filter((record) => record.visibility === "list");
    let source: ProxyModelMeta["source"] = "static";
    let probeStatus: ProxyModelMeta["probeStatus"] = "skipped";

    try {
        const { token, accountId } = await resolveOpenAiSubToken(account, { noRefresh: options?.probe });
        const live = await tryFetchWhamModels(token, accountId, account.baseUrl);

        if (live && live.length > 0) {
            records = live.filter((record) => record.visibility === "list");
            source = "api-catalog";
            probeStatus = "ok";
        } else {
            logger.debug({ account: account.name }, "ai-proxy: codex catalog static fallback");
        }
    } catch (err) {
        logger.debug({ err, account: account.name }, "ai-proxy: codex catalog auth/list failed — static fallback");
    }

    const toMeta = (id: string, record: WhamModelRecord, description: string): ProxyModelMeta => ({
        proxyId: toProxyId(account.name, account.providerSlug, id),
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId: record.slug,
        provider: account.provider,
        baseUrl: WHAM_RESPONSES_BASE_URL,
        visibility: "high" as const,
        speed: "medium" as const,
        thinking: "reasoning" as const,
        contextWindow: record.contextWindow,
        supportsTools: true,
        inputModalities: record.inputModalities,
        supportsParallelToolCalls: record.supportsParallelToolCalls,
        billingPlane: "subscription" as const,
        source,
        probeStatus,
        description,
        object: "model" as const,
        created: 1_740_960_000,
        owned_by: providerKey(account),
    });

    // Aliases (builtin + per-account config) advertised when they resolve to a
    // record on this plan's list.
    const aliasNames = [...OPENAI_SUB_BUILTIN_ALIAS_NAMES, ...Object.keys(account.openaiSub?.aliases ?? {})];
    const aliases: ProxyModelMeta[] = [];

    for (const alias of aliasNames) {
        const concrete = resolveOpenAiSubModel(alias, account.openaiSub?.aliases);
        const record = records.find((item) => item.slug === concrete);

        if (concrete === alias || !record) {
            continue;
        }

        aliases.push(toMeta(alias, record, `Codex ${alias} alias (${concrete})`));
    }

    return [
        ...aliases,
        ...records.map((record) => toMeta(record.slug, record, `${record.displayName} via ChatGPT/Codex subscription`)),
    ];
}
