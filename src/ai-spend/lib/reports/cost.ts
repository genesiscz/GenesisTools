import { costOf, priceFor, resolvePrice } from "../pricing";
import type { PricingTable } from "../types";
import type { CostMode, SpendEvent } from "./types";

export interface CostEstimate {
    costUSD: number | null;
    pricingModel?: string;
    longContext: boolean;
    basis: "recorded" | "catalog" | "unpriced";
}

export function catalogEstimate(event: SpendEvent, pricing: PricingTable, candidates: string[]): CostEstimate {
    for (const model of candidates) {
        const entry = priceFor(model, pricing);
        if (!entry) {
            continue;
        }

        const at = new Date(event.timestamp);
        const context = {
            at: Number.isNaN(at.getTime()) ? undefined : at,
            serviceTier: event.serviceTier,
            contextTokens: event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens,
        };
        const price = resolvePrice(entry, context);
        const short = resolvePrice(entry, { ...context, contextTokens: 0 });
        return {
            costUSD: costOf(
                {
                    input: event.inputTokens,
                    output: event.outputTokens,
                    cacheWrite: event.cacheCreationTokens,
                    cacheRead: event.cacheReadTokens,
                },
                price
            ),
            pricingModel: model,
            longContext:
                price.input !== short.input ||
                price.output !== short.output ||
                price.cacheRead !== short.cacheRead ||
                price.cacheWrite !== short.cacheWrite,
            basis: "catalog",
        };
    }

    return { costUSD: null, longContext: false, basis: "unpriced" };
}

export function catalogCost(event: SpendEvent, pricing: PricingTable, candidates: string[]): number {
    return catalogEstimate(event, pricing, candidates).costUSD ?? 0;
}

export function eventCostEstimate(
    event: SpendEvent,
    pricing: PricingTable,
    mode: CostMode,
    candidates: string[]
): CostEstimate {
    if (mode !== "calculate" && event.recordedCostUsd !== undefined) {
        return { costUSD: event.recordedCostUsd, longContext: false, basis: "recorded" };
    }

    if (mode === "display") {
        return { costUSD: null, longContext: false, basis: "unpriced" };
    }

    return catalogEstimate(event, pricing, candidates);
}

export function eventCost(event: SpendEvent, pricing: PricingTable, mode: CostMode, candidates: string[]): number {
    return eventCostEstimate(event, pricing, mode, candidates).costUSD ?? 0;
}

export function priceCandidates(model: string): string[] {
    return [model];
}

export function totalTokensOf(event: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}): number {
    return event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens;
}
