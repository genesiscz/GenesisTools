import { byProvider, stripModelVariantSuffix } from "@genesiscz/utils/ai/catalog";
import type { ModelPrice, PricingTable, TokenTotals } from "./types";

/**
 * EXACT id match, with one boundary-safe fallback: a trailing `-YYYYMMDD` /
 * `-latest` suffix is stripped and the exact lookup retried. Never an
 * open-ended prefix match — an unlisted id reports unpriced rather than
 * costing at a guessed family rate. Rates come from the curated registry
 * (`@genesiscz/utils/ai/catalog`); update them there.
 *
 * Monitor drivers widen the lookup with their own candidate ladders (codex
 * peels `-codex` / `-sol`, grok peels `-build`), but every candidate still has
 * to hit an EXACT key here.
 */

/**
 * Providers whose catalog rates the monitor can bill against.
 *
 * `openai-sub` and `xai` carry NO rates in the catalog (they are subscription
 * and CLI-plan models, not metered API ids), so they contribute nothing today
 * and every id they own is unpriced. They are listed anyway so that the day a
 * rate lands in the catalog it flows straight through. Grok does not need them:
 * it records its own `costUsdTicks` per turn, which the driver reports as the
 * authoritative cost.
 */
const PRICED_PROVIDERS = ["anthropic", "openai", "openai-sub", "xai"] as const;

/** $/Mtok. cacheWrite ≈ 1.25× input, cacheRead ≈ 0.1× input (Anthropic public ratios). */
function fromRegistry(): PricingTable {
    const table: PricingTable = {};

    for (const provider of PRICED_PROVIDERS) {
        for (const model of byProvider(provider)) {
            if (!model.pricing) {
                continue;
            }

            const price: ModelPrice = {
                input: model.pricing.inputPer1M,
                output: model.pricing.outputPer1M,
                cacheWrite: model.pricing.cachedCreatePer1M ?? model.pricing.inputPer1M * 1.25,
                cacheRead: model.pricing.cachedReadPer1M ?? model.pricing.inputPer1M * 0.1,
            };

            for (const id of [model.id, model.flags?.cli?.id]) {
                // First provider to name an id wins, so an unpriced duplicate can
                // never shadow a priced one.
                if (id && !table[id]) {
                    table[id] = price;
                }
            }
        }
    }

    return table;
}

/** Claude 3.5 Haiku predates the curated registry — kept literal here (exact ids). */
const LEGACY_PRICING: PricingTable = {
    "claude-3-5-haiku": { input: 0.8, output: 4, cacheWrite: 1.0, cacheRead: 0.08 },
};

export const DEFAULT_PRICING: PricingTable = { ...fromRegistry(), ...LEGACY_PRICING };

export function priceFor(model: string, pricing: PricingTable): ModelPrice | null {
    const exact = pricing[model];

    if (exact) {
        return exact;
    }

    const base = stripModelVariantSuffix(model);
    return (base && pricing[base]) || null;
}

export function costOf(tokens: TokenTotals, price: ModelPrice): number {
    return (
        (tokens.input * price.input +
            tokens.output * price.output +
            tokens.cacheWrite * price.cacheWrite +
            tokens.cacheRead * price.cacheRead) /
        1_000_000
    );
}
