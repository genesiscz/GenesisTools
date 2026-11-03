import { costOf, DEFAULT_PRICING, priceFor, resolvePrice } from "@genesiscz/utils/ai/usage/spend/pricing";
import type { ModelPrice, PricingTable } from "@genesiscz/utils/ai/usage/spend/types";
import type { SessionCall } from "../analysis-types";

/**
 * The catalog price of one call's model at the call's own moment and size; null for a model with no known rate. An
 * aggregate row sums requests whose own sizes are unknown, so it takes no context band (as the spend reports do).
 */
export function priceOfCall(call: SessionCall, pricing: PricingTable = DEFAULT_PRICING): ModelPrice | null {
    const entry = priceFor(call.model, pricing);

    if (!entry) {
        return null;
    }

    const contextTokens = call.aggregate ? undefined : call.input + call.cacheRead + call.cacheWrite;

    return resolvePrice(entry, { at: new Date(call.t), contextTokens });
}

/**
 * One call's list-price cost: the harness's own recorded cost when it wrote one, else the catalog rate through the one
 * cost function (`costOf` over `calculateCallCostUsd`); null when the model has no known rate.
 */
export function callCostUsd(call: SessionCall, pricing: PricingTable = DEFAULT_PRICING): number | null {
    if (call.recordedCostUsd !== undefined) {
        return call.recordedCostUsd;
    }

    const price = priceOfCall(call, pricing);

    if (!price) {
        return null;
    }

    return costOf(
        {
            input: call.input,
            output: call.output,
            cacheWrite: call.cacheWrite,
            cacheRead: call.cacheRead,
            ...(call.cacheWrite1h === undefined ? {} : { cacheWrite1h: call.cacheWrite1h }),
        },
        price
    );
}

/**
 * What the next prompt costs extra when the cache expired first (proposal 11): the context written again at the
 * cache-write rate instead of read at the cache-read rate. `oneHour` picks the one-hour write rate where the model has
 * one. Null without a known rate.
 */
export function coldRebuildUsd(input: {
    model: string;
    contextTokens: number;
    oneHour: boolean;
    at: Date;
    pricing?: PricingTable;
}): number | null {
    const entry = priceFor(input.model, input.pricing ?? DEFAULT_PRICING);

    if (!entry) {
        return null;
    }

    const price = resolvePrice(entry, { at: input.at, contextTokens: input.contextTokens });
    const write = input.oneHour ? (price.cacheWrite1h ?? price.cacheWrite) : price.cacheWrite;
    return (input.contextTokens * (write - price.cacheRead)) / 1_000_000;
}
