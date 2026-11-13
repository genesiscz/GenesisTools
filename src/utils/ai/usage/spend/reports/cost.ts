import { type CostEstimate, priceUsage, type UsageToPrice } from "../priced-usage";
import type { PricingTable } from "../types";
import type { CostMode, SpendEvent } from "./types";

export type { CostEstimate } from "../priced-usage";

/** The fields a price needs; a `SpendEvent` and a monitor event both carry them. */
export type CostableEvent = Pick<
    SpendEvent,
    | "source"
    | "model"
    | "timestamp"
    | "inputTokens"
    | "outputTokens"
    | "cacheCreationTokens"
    | "cacheCreation1hTokens"
    | "cacheReadTokens"
    | "aggregate"
    | "recordedCostUsd"
    | "serviceTier"
>;

/** One spend event as the priced-usage module reads it. */
export function spendEventUsage(event: CostableEvent): UsageToPrice {
    return {
        source: event.source,
        model: event.model,
        at: event.timestamp,
        tokens: {
            input: event.inputTokens,
            output: event.outputTokens,
            cacheWrite: event.cacheCreationTokens,
            cacheRead: event.cacheReadTokens,
            cacheWrite1h: event.cacheCreation1hTokens,
        },
        aggregate: event.aggregate,
        serviceTier: event.serviceTier,
        recordedCostUsd: event.recordedCostUsd,
    };
}

/** The catalog price alone, whatever the event recorded; 0 when the catalog cannot price it. */
export function catalogCost(event: SpendEvent, pricing: PricingTable, candidates: string[]): number {
    return priceUsage(spendEventUsage(event), { mode: "calculate", table: pricing, candidates }).costUSD ?? 0;
}

export function eventCostEstimate(
    event: CostableEvent,
    pricing: PricingTable,
    mode: CostMode,
    candidates: string[]
): CostEstimate {
    const { price: _price, ...estimate } = priceUsage(spendEventUsage(event), { mode, table: pricing, candidates });
    return estimate;
}

export function eventCost(event: SpendEvent, pricing: PricingTable, mode: CostMode, candidates: string[]): number {
    return eventCostEstimate(event, pricing, mode, candidates).costUSD ?? 0;
}

export function totalTokensOf(event: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}): number {
    return event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens;
}
