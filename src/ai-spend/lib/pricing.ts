import { byProvider, effectivePricing, stripModelVariantSuffix } from "@genesiscz/utils/ai/catalog";
import { calculateCallCostUsd } from "@genesiscz/utils/ai/llm-cost";
import { toLanguageModelUsage } from "@genesiscz/utils/ask/usage-tokens";
import type { ModelPrice, ModelPriceEntry, PricingTable, TokenTotals } from "./types";

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
 * `openai-sub` carries NO rates in the catalog (subscription slugs, not metered
 * API ids); it is listed so that the day a rate lands it flows straight through.
 * `xai` carries xAI's list prices (`XAI_PRICING` in the catalog). Grok's own
 * `costUsdTicks` is its plan metering, not a list price, so it is only a
 * fallback for an id these rates do not cover (`recordedCostIsListPrice`).
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

            // `rules` rides along: flattening the catalog to four numbers billed
            // every event at the list rate, so dated promotions (the Sonnet 5
            // $2/$10 window) and long-context bands never reached the report.
            const price: ModelPriceEntry = {
                input: model.pricing.inputPer1M,
                output: model.pricing.outputPer1M,
                cacheWrite: model.pricing.cachedCreatePer1M ?? model.pricing.inputPer1M * 1.25,
                cacheRead: model.pricing.cachedReadPer1M ?? model.pricing.inputPer1M * 0.1,
                ...(model.pricing.cachedCreate1hPer1M === undefined
                    ? {}
                    : { cacheWrite1h: model.pricing.cachedCreate1hPer1M }),
                rules: model.pricing.rules,
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

export const DEFAULT_PRICING: PricingTable = fromRegistry();

export function priceFor(model: string, pricing: PricingTable): ModelPriceEntry | null {
    const exact = pricing[model];

    if (exact) {
        return exact;
    }

    const base = stripModelVariantSuffix(model);
    return (base && pricing[base]) || null;
}

/**
 * Apply the catalog's dated / context-banded rules to ONE event's own moment and
 * size. `effectivePricing` is the single resolver for that (see the AI-subsystem
 * rules); this only translates its per-1M fields into the flat shape costOf wants.
 */
export function resolvePrice(
    entry: ModelPriceEntry,
    context: { at?: Date; contextTokens?: number; serviceTier?: string } = {}
): ModelPrice {
    if (!entry.rules?.length) {
        return entry;
    }

    const resolved = effectivePricing(
        {
            inputPer1M: entry.input,
            outputPer1M: entry.output,
            cachedCreatePer1M: entry.cacheWrite,
            cachedReadPer1M: entry.cacheRead,
            ...(entry.cacheWrite1h === undefined ? {} : { cachedCreate1hPer1M: entry.cacheWrite1h }),
            rules: entry.rules,
        },
        context
    );

    return {
        input: resolved.inputPer1M,
        output: resolved.outputPer1M,
        cacheWrite: resolved.cachedCreatePer1M ?? resolved.inputPer1M * 1.25,
        cacheRead: resolved.cachedReadPer1M ?? resolved.inputPer1M * 0.1,
        ...(resolved.cachedCreate1hPer1M === undefined ? {} : { cacheWrite1h: resolved.cachedCreate1hPer1M }),
    };
}

export function costOf(tokens: TokenTotals, price: ModelPrice): number {
    return (
        calculateCallCostUsd(
            {
                inputPer1M: price.input,
                outputPer1M: price.output,
                cachedCreatePer1M: price.cacheWrite,
                cachedReadPer1M: price.cacheRead,
                ...(price.cacheWrite1h === undefined ? {} : { cachedCreate1hPer1M: price.cacheWrite1h }),
            },
            toLanguageModelUsage({
                inputTokens: tokens.input,
                outputTokens: tokens.output,
                cacheWriteTokens: tokens.cacheWrite,
                cachedInputTokens: tokens.cacheRead,
            }),
            { cacheWrite1hTokens: tokens.cacheWrite1h }
        ) ?? 0
    );
}
