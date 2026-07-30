import { logger } from "@genesiscz/utils/logger";
import { liteLLMPricingFetcher } from "./litellm";
import { byId } from "./static";
import type { ModelPricing } from "./types";

/**
 * The one price ladder: curated static price, then LiteLLM, then OpenRouter.
 *
 * Static first because those rates are hand-verified against provider pricing
 * pages and carry cache tiers the feeds often omit. What is gone is a fourth
 * source — a hardcoded "OpenAI pricing as of 2024" map that outranked every
 * live feed and had been wrong since OpenAI's price cuts, quietly reporting
 * gpt-4o at twice its real rate.
 */

interface CacheEntry {
    pricing: ModelPricing | undefined;
    at: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export interface OpenRouterPricingShape {
    prompt?: string | number;
    completion?: string | number;
    cache_read?: string | number;
    input_cache_read?: string | number;
}

function toNumber(value: string | number | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** OpenRouter quotes per token; everything else in this layer is per 1M. */
export function convertOpenRouterPricing(pricing: OpenRouterPricingShape): ModelPricing {
    const cached = toNumber(pricing.cache_read) ?? toNumber(pricing.input_cache_read);

    return {
        inputPer1M: (toNumber(pricing.prompt) ?? 0) * 1_000_000,
        outputPer1M: (toNumber(pricing.completion) ?? 0) * 1_000_000,
        ...(cached === undefined ? {} : { cachedReadPer1M: cached * 1_000_000 }),
    };
}

async function fetchOpenRouterPricing(modelId: string): Promise<ModelPricing | undefined> {
    try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { "X-Title": "GenesisTools" },
        });

        if (!response.ok) {
            throw new Error(`OpenRouter API error: ${response.status}`);
        }

        const data = (await response.json()) as { data: Array<{ id: string; pricing?: OpenRouterPricingShape }> };
        const model = data.data.find((entry) => entry.id === modelId);

        if (!model?.pricing) {
            return undefined;
        }

        return convertOpenRouterPricing(model.pricing);
    } catch (err) {
        logger.warn({ err, modelId }, "OpenRouter pricing lookup failed");
        return undefined;
    }
}

/** LiteLLM keys models differently per provider; try the plausible spellings. */
function liteLlmCandidates(provider: string, modelId: string): string[] {
    if (provider === "openrouter") {
        return [`openrouter/${modelId}`, modelId];
    }

    return [`${provider}/${modelId}`, modelId];
}

async function fetchLiteLlmPricing(provider: string, modelId: string): Promise<ModelPricing | undefined> {
    for (const candidate of liteLlmCandidates(provider, modelId)) {
        try {
            const found = await liteLLMPricingFetcher.getModelPricing(candidate);

            if (found) {
                logger.debug({ provider, modelId, candidate }, "pricing resolved from LiteLLM");
                return liteLLMPricingFetcher.convertToPricingInfo(found);
            }
        } catch (err) {
            logger.debug({ err, candidate }, "LiteLLM pricing lookup failed for candidate");
        }
    }

    return undefined;
}

/**
 * The static price counts only when the catalog entry belongs to the SAME
 * provider the call is billed against. Without this check, asking for an
 * openrouter-routed `claude-opus-5` returned Anthropic's direct list price —
 * the wrong vendor's rate for the route actually being paid.
 */
function scopedStaticPricing(provider: string, modelId: string): ModelPricing | undefined {
    const entry = byId(modelId);

    if (!entry || entry.provider !== provider) {
        return undefined;
    }

    return entry.pricing;
}

export async function pricingFor(provider: string, modelId: string): Promise<ModelPricing | undefined> {
    const key = `${provider}/${modelId}`;
    const hit = cache.get(key);

    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return hit.pricing;
    }

    const resolved =
        scopedStaticPricing(provider, modelId) ??
        (await fetchLiteLlmPricing(provider, modelId)) ??
        (await fetchOpenRouterPricing(provider === "openrouter" ? modelId : `${provider}/${modelId}`));

    if (resolved) {
        cache.set(key, { pricing: resolved, at: Date.now() });
    }

    return resolved;
}

export function clearPricingCache(): void {
    cache.clear();
}

export function pricingCacheSize(): number {
    return cache.size;
}
