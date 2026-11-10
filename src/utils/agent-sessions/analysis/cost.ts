import type { AgentId } from "@genesiscz/utils/ai/usage/spend/drivers";
import { type PricedUsage, priceUsage } from "@genesiscz/utils/ai/usage/spend/priced-usage";
import type { ModelPrice, PricingTable } from "@genesiscz/utils/ai/usage/spend/types";
import type { SessionCall } from "../analysis-types";

/**
 * How a session's calls are priced: the harness that wrote them, whose spend driver names the candidate models a
 * recorded model is priced as (`grok-4.6-build` as `grok-4.6`), and the table (the catalog unless a test gives one).
 */
export interface CallPricing {
    agent: AgentId;
    table?: PricingTable;
}

/** One call through the priced-usage module, the one the spend reports ask. */
function priceOf(call: SessionCall, pricing: CallPricing): PricedUsage {
    return priceUsage(
        {
            source: pricing.agent,
            model: call.model,
            at: call.t,
            tokens: {
                input: call.input,
                output: call.output,
                cacheWrite: call.cacheWrite,
                cacheRead: call.cacheRead,
                cacheWrite1h: call.cacheWrite1h,
            },
            aggregate: call.aggregate,
            serviceTier: call.serviceTier,
            recordedCostUsd: call.recordedCostUsd,
        },
        { table: pricing.table }
    );
}

/**
 * The catalog price of one call's model at the call's own moment, size and service tier; null for a model with no
 * known rate. An aggregate row sums requests whose own sizes are unknown, so it takes no context band.
 */
export function priceOfCall(call: SessionCall, pricing: CallPricing): ModelPrice | null {
    return priceOf(call, pricing).price;
}

/**
 * One call's list-price cost, by the spend reports' recorded-cost rule (the harness's `MonitorDriver.recordedCost`):
 * a recorded list price stands, else the catalog rate, else a recorded metering figure; null when nothing prices it.
 */
export function callCostUsd(call: SessionCall, pricing: CallPricing): number | null {
    return priceOf(call, pricing).costUSD;
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
    serviceTier?: string;
    pricing: CallPricing;
}): number | null {
    // The context as one request's input, so the rate resolves at the band of that context size.
    const { price } = priceUsage(
        {
            source: input.pricing.agent,
            model: input.model,
            at: input.at,
            tokens: { input: input.contextTokens, output: 0, cacheWrite: 0, cacheRead: 0 },
            serviceTier: input.serviceTier,
        },
        { table: input.pricing.table }
    );

    if (!price) {
        return null;
    }

    const write = input.oneHour ? (price.cacheWrite1h ?? price.cacheWrite) : price.cacheWrite;
    return (input.contextTokens * (write - price.cacheRead)) / 1_000_000;
}
