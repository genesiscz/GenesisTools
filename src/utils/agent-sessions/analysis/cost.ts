import { type AgentId, spendDriver } from "@genesiscz/utils/ai/usage/spend/drivers";
import { costOf, DEFAULT_PRICING, priceForCandidates, resolvePrice } from "@genesiscz/utils/ai/usage/spend/pricing";
import { chooseCost } from "@genesiscz/utils/ai/usage/spend/reports/cost";
import type { ModelPrice, ModelPriceEntry, PricingTable } from "@genesiscz/utils/ai/usage/spend/types";
import type { SessionCall } from "../analysis-types";

/**
 * How a session's calls are priced: the harness that wrote them, whose spend driver names the candidate models a
 * recorded model is priced as (`grok-4.6-build` as `grok-4.6`), and the table (the catalog unless a test gives one).
 */
export interface CallPricing {
    agent: AgentId;
    table?: PricingTable;
}

/** The catalog entry of a model through its harness's candidate ladder, the one the spend reports walk. */
function entryOf(model: string, pricing: CallPricing): ModelPriceEntry | null {
    const candidates = spendDriver(pricing.agent).priceCandidates(model);
    return priceForCandidates(candidates, pricing.table ?? DEFAULT_PRICING)?.entry ?? null;
}

/**
 * The catalog price of one call's model at the call's own moment and size; null for a model with no known rate. An
 * aggregate row sums requests whose own sizes are unknown, so it takes no context band (as the spend reports do).
 */
export function priceOfCall(call: SessionCall, pricing: CallPricing): ModelPrice | null {
    const entry = entryOf(call.model, pricing);

    if (!entry) {
        return null;
    }

    const contextTokens = call.aggregate ? undefined : call.input + call.cacheRead + call.cacheWrite;

    // The service tier too, as the spend reports price it: a priority call is not billed at the standard rate.
    return resolvePrice(entry, { at: new Date(call.t), contextTokens, serviceTier: call.serviceTier });
}

/**
 * One call's list-price cost, by the spend reports' recorded-cost rule (`chooseCost`, the harness's
 * `MonitorDriver.recordedCost`): a recorded list price stands, else the catalog rate through the one cost function
 * (`costOf` over `calculateCallCostUsd`), else a recorded metering figure; null when nothing prices the call.
 */
export function callCostUsd(call: SessionCall, pricing: CallPricing): number | null {
    return chooseCost({
        source: pricing.agent,
        recorded: call.recordedCostUsd,
        mode: "auto",
        catalog: () => {
            const costUSD = catalogCostUsd(call, pricing);
            return { costUSD, longContext: false, basis: costUSD === null ? "unpriced" : "catalog" };
        },
    }).costUSD;
}

/** The catalog rate of one call through the one cost function; null for a model with no known rate. */
function catalogCostUsd(call: SessionCall, pricing: CallPricing): number | null {
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
    serviceTier?: string;
    pricing: CallPricing;
}): number | null {
    const entry = entryOf(input.model, input.pricing);

    if (!entry) {
        return null;
    }

    const price = resolvePrice(entry, {
        at: input.at,
        contextTokens: input.contextTokens,
        serviceTier: input.serviceTier,
    });
    const write = input.oneHour ? (price.cacheWrite1h ?? price.cacheWrite) : price.cacheWrite;
    return (input.contextTokens * (write - price.cacheRead)) / 1_000_000;
}
