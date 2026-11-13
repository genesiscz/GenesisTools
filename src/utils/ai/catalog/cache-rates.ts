import type { ModelPricing } from "./types";

/** A provider family's cache rates as multiples of the input rate, for an entry that lists none. */
export interface CacheRateDefault {
    writeOfInput?: number;
    readOfInput?: number;
}

/**
 * What a provider family bills for a cache write or read the price list leaves out. Both pricing families read it
 * off the catalog entry (`withCacheRateDefaults`): `tools ask` through `pricingFor` and llm-cost, the spend reports
 * through their table. A provider that is absent has no default, and a missing rate bills 0 in both.
 *
 * - anthropic: a five-minute write is 1.25x input and a read 0.1x (platform.claude.com pricing, read 2026-11-10).
 * - openai: a write is not an additive fee; a model without a cache-write price bills it at the plain input rate
 *   (developers.openai.com/api/docs/guides/prompt-caching, read 2026-11-10). Every OpenAI entry lists its read rate.
 */
const CACHE_RATE_DEFAULTS: Readonly<Record<string, CacheRateDefault>> = {
    anthropic: { writeOfInput: 1.25, readOfInput: 0.1 },
    openai: { writeOfInput: 1 },
};

export function cacheRateDefaultFor(provider: string): CacheRateDefault | undefined {
    return CACHE_RATE_DEFAULTS[provider];
}

/**
 * The pricing with the provider family's default filled in for each cache rate it leaves out. Rules are left alone:
 * a rule overrides only the rates it names, so the base cache rate carries through it.
 */
export function withCacheRateDefaults(pricing: ModelPricing, provider: string): ModelPricing {
    const fallback = cacheRateDefaultFor(provider);

    if (!fallback) {
        return pricing;
    }

    const write =
        pricing.cachedCreatePer1M ??
        (fallback.writeOfInput === undefined ? undefined : pricing.inputPer1M * fallback.writeOfInput);
    const read =
        pricing.cachedReadPer1M ??
        (fallback.readOfInput === undefined ? undefined : pricing.inputPer1M * fallback.readOfInput);

    return {
        ...pricing,
        ...(write === undefined ? {} : { cachedCreatePer1M: write }),
        ...(read === undefined ? {} : { cachedReadPer1M: read }),
    };
}
