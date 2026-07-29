import { logger } from "@genesiscz/utils/logger";
import { liteLLMPricingFetcher } from "./litellm";
import { byId } from "./static";
import type { ModelPricing, PricingRule } from "./types";

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
export function convertOpenRouterPricing(pricing: OpenRouterPricingShape): ModelPricing | undefined {
    const input = toNumber(pricing.prompt);
    const output = toNumber(pricing.completion);

    // Absent means UNKNOWN, never free — the invariant this layer states at
    // catalog/types.ts. Coercing a missing field to 0 produced a truthy pricing
    // object, which then got cached for an hour and booked the call at $0,
    // indistinguishable from a genuinely free model and invisible to the
    // `unpricedEvents` accounting. An explicit 0 is preserved: OpenRouter's
    // `:free` routes really do quote "0", which is why this is a presence check
    // rather than a truthiness check.
    if (input === undefined || output === undefined) {
        return undefined;
    }

    const cached = toNumber(pricing.cache_read) ?? toNumber(pricing.input_cache_read);

    return {
        inputPer1M: input * 1_000_000,
        outputPer1M: output * 1_000_000,
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
    return byId(modelId, provider)?.pricing;
}

/**
 * The ladder answers with rates as published, rules included and UNRESOLVED —
 * resolving needs a request's date and size, which only the caller has. Pass the
 * result through `effectivePricing` to get the rate an actual call would bill.
 */
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

export interface PricingContext {
    /** When the call happens. Omit and dated rules simply do not apply. */
    at?: Date;
    /** The request's token count. Omit and context-banded rules do not apply. */
    contextTokens?: number;
}

/** ISO dates compare correctly as strings, and UTC keeps the boundary reproducible. */
function utcDay(at: Date): string {
    return at.toISOString().slice(0, 10);
}

/**
 * An absent condition is open-ended; an absent INPUT fails the condition.
 *
 * That asymmetry is deliberate. A caller who does not say when the call happens
 * cannot have a dated discount applied on their behalf, and one who does not say
 * how long the prompt is cannot be charged a long-context surcharge. Both
 * unknowns therefore fall back to the base rate rather than guessing, and the
 * guess that would have been convenient (assume "now") is also the one that
 * makes this function untestable.
 */
function ruleApplies(rule: PricingRule, context: PricingContext): boolean {
    const dated = rule.from !== undefined || rule.to !== undefined;

    if (dated) {
        if (!context.at) {
            return false;
        }

        const day = utcDay(context.at);

        if ((rule.from !== undefined && day < rule.from) || (rule.to !== undefined && day > rule.to)) {
            return false;
        }
    }

    const banded = rule.ctxFrom !== undefined || rule.ctxTo !== undefined;

    if (banded) {
        const tokens = context.contextTokens;

        if (tokens === undefined) {
            return false;
        }

        if (
            (rule.ctxFrom !== undefined && tokens < rule.ctxFrom) ||
            (rule.ctxTo !== undefined && tokens > rule.ctxTo)
        ) {
            return false;
        }
    }

    return true;
}

/**
 * Resolve conditional rates into the one price that applies.
 *
 * Pure: same arguments, same answer, no clock and no I/O. Matching rules are
 * applied in array order and a later match wins field by field, so a promo rule
 * placed after a context tier overrides only the fields it names.
 *
 * The result carries no `rules` — it is the resolved price, and dropping them
 * makes re-applying it to itself impossible rather than merely wrong.
 */
export function effectivePricing(pricing: ModelPricing, context: PricingContext = {}): ModelPricing {
    const { rules, ...base } = pricing;

    if (!rules || rules.length === 0) {
        return base;
    }

    const resolved: ModelPricing = { ...base };

    for (const rule of rules) {
        if (!ruleApplies(rule, context)) {
            continue;
        }

        for (const field of ["inputPer1M", "outputPer1M", "cachedReadPer1M", "cachedCreatePer1M"] as const) {
            const override = rule[field];

            if (override !== undefined) {
                resolved[field] = override;
            }
        }
    }

    return resolved;
}

export function clearPricingCache(): void {
    cache.clear();
}

export function pricingCacheSize(): number {
    return cache.size;
}
