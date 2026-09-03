import { priceFor, resolvePrice } from "../pricing";
import type { PricingTable } from "../types";
import type { CostMode, SpendEvent } from "./types";

export function catalogCost(event: SpendEvent, pricing: PricingTable, candidates: string[]): number {
    for (const model of candidates) {
        const entry = priceFor(model, pricing);

        if (!entry) {
            continue;
        }

        const at = new Date(event.timestamp);
        const price = resolvePrice(entry, {
            at: Number.isNaN(at.getTime()) ? undefined : at,
            contextTokens: event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens,
        });

        return (
            (event.inputTokens * price.input +
                event.outputTokens * price.output +
                event.cacheCreationTokens * price.cacheWrite +
                event.cacheReadTokens * price.cacheRead) /
            1_000_000
        );
    }

    return 0;
}

export function eventCost(event: SpendEvent, pricing: PricingTable, mode: CostMode, candidates: string[]): number {
    if (mode === "display") {
        return event.recordedCostUsd ?? 0;
    }

    const calculated = catalogCost(event, pricing, candidates);

    if (mode === "calculate") {
        return calculated;
    }

    return event.recordedCostUsd ?? calculated;
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
