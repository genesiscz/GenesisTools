import { OPENROUTER_API_BASE_URL } from "@app/ai-proxy/lib/providers/openrouter-api-key";
import { providerKey } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import {
    DEFAULT_OPENROUTER_EXCLUDE,
    DEFAULT_OPENROUTER_INCLUDE,
    fetchOpenRouterCatalog,
    OPENROUTER_META_MODEL_IDS,
    type OpenRouterModelRecord,
} from "@genesiscz/utils/ai/catalog";
import { toProxyId } from "@genesiscz/utils/ai/grok";
import { logger } from "@genesiscz/utils/logger";
import { matchGlob } from "@genesiscz/utils/string";

/**
 * Which OpenRouter ids this account advertises.
 *
 * `??` and not `||`: absent means "use the curated default", while an explicit
 * `[]` means "no filter at all". Collapsing the two would make `include: []`
 * silently mean the opposite of what it reads as.
 */
function openRouterFilters(account: AiProxyAccountConfig): { include: readonly string[]; exclude: readonly string[] } {
    const configured = account.openrouter?.models;
    const include = configured?.include ?? DEFAULT_OPENROUTER_INCLUDE;

    return {
        // An empty include list, like ["*"], means every model OpenRouter serves.
        include: include.length === 0 ? ["*"] : include,
        exclude: configured?.exclude ?? DEFAULT_OPENROUTER_EXCLUDE,
    };
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => matchGlob(value, pattern));
}

function openRouterRecordToProxyMeta(
    account: AiProxyAccountConfig,
    model: OpenRouterModelRecord,
    baseUrl: string
): ProxyModelMeta {
    const inputModalities = model.architecture?.input_modalities;
    const parameters = model.supported_parameters ?? [];

    return {
        proxyId: toProxyId(account.name, account.providerSlug, model.id),
        accountName: account.name,
        providerSlug: account.providerSlug,
        upstreamId: model.id,
        provider: account.provider,
        baseUrl,
        visibility: "medium",
        speed: "medium",
        // Real data, not inferred from the id: OpenRouter declares reasoning
        // support per model, and whether it is mandatory.
        thinking: model.reasoning ? (model.reasoning.mandatory ? "reasoning" : "optional") : "none",
        ...(typeof model.context_length === "number" ? { contextWindow: model.context_length } : {}),
        ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
        supportsTools: parameters.includes("tools"),
        billingPlane: "api-key",
        source: "api-catalog",
        description: `${model.name ?? model.id} via OpenRouter`,
        object: "model",
        created: 1_740_960_000,
        owned_by: providerKey(account),
    };
}

/**
 * OpenRouter models advertised to clients, from the shared catalog module.
 *
 * ⚠️ No `assertApiKeySourceAllowed` here, deliberately, and not an oversight:
 * `/api/v1/models` is PUBLIC and this path spends no key, so guarding it would
 * only hide the catalog from an account whose key happens to come from the
 * environment. The xai equivalent needs the guard because it authenticates.
 */
export async function listOpenRouterProxyModels(account: AiProxyAccountConfig): Promise<ProxyModelMeta[]> {
    const baseUrl = (account.baseUrl ?? OPENROUTER_API_BASE_URL).replace(/\/$/, "");
    const catalog = await fetchOpenRouterCatalog();
    const { include, exclude } = openRouterFilters(account);

    if (!catalog) {
        logger.warn({ account: account.name }, "ai-proxy: openrouter catalog unavailable — advertising no models");
        return [];
    }

    const meta = new Set(OPENROUTER_META_MODEL_IDS);

    return (
        catalog.models
            // The five `-1`-priced router pseudo-models are always dropped: they are
            // not models, and they cannot be priced.
            .filter((model) => !meta.has(model.id))
            .filter((model) => matchesAny(model.id, include) && !matchesAny(model.id, exclude))
            .map((model) => openRouterRecordToProxyMeta(account, model, baseUrl))
    );
}
