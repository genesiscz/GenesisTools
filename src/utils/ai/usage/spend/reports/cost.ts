import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { spendDriver } from "../drivers";
import { costOf, priceForCandidates, resolvePrice } from "../pricing";
import type { PricingTable } from "../types";
import type { CostMode, SourceId, SpendEvent } from "./types";

export interface CostEstimate {
    costUSD: number | null;
    pricingModel?: string;
    longContext: boolean;
    /**
     * `recorded`: a cost the source recorded, and that cost IS the list price (ccusage semantics).
     * `catalog`: list rates per request. `reported`: the agent's own figure, used only because the
     * catalog cannot price the model, and NOT a list price (grok's plan metering).
     */
    basis: "recorded" | "catalog" | "reported" | "unpriced";
}

/** The fields a price needs; a `SpendEvent` and a monitor event both carry them. */
export type CostableEvent = Pick<
    SpendEvent,
    | "source"
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

/**
 * Whether a source's recorded cost is the list price: a coding-agent harness says so through its spend driver
 * (`MonitorDriver.recordedCost`; Grok's is plan metering), and every other ccusage source records list prices.
 */
export function recordedCostIsListPrice(source: SourceId): boolean {
    return !isAccountProviderAlias(source) || spendDriver(source).recordedCost === "list-price";
}

export function catalogEstimate(event: CostableEvent, pricing: PricingTable, candidates: string[]): CostEstimate {
    const found = priceForCandidates(candidates, pricing);

    if (!found) {
        return { costUSD: null, longContext: false, basis: "unpriced" };
    }

    const at = new Date(event.timestamp);
    // A context band bills per request. An event that sums several requests has lost their
    // lengths, so it prices at the base band rather than at the band of the SUM.
    const context = {
        at: Number.isNaN(at.getTime()) ? undefined : at,
        serviceTier: event.serviceTier,
        contextTokens: event.aggregate
            ? undefined
            : event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens,
    };
    const price = resolvePrice(found.entry, context);
    const short = resolvePrice(found.entry, { ...context, contextTokens: 0 });
    return {
        costUSD: costOf(
            {
                input: event.inputTokens,
                output: event.outputTokens,
                cacheWrite: event.cacheCreationTokens,
                cacheRead: event.cacheReadTokens,
                cacheWrite1h: event.cacheCreation1hTokens,
            },
            price
        ),
        pricingModel: found.model,
        longContext:
            price.input !== short.input ||
            price.output !== short.output ||
            price.cacheRead !== short.cacheRead ||
            price.cacheWrite !== short.cacheWrite,
        basis: "catalog",
    };
}

export function catalogCost(event: SpendEvent, pricing: PricingTable, candidates: string[]): number {
    return catalogEstimate(event, pricing, candidates).costUSD ?? 0;
}

export function eventCostEstimate(
    event: CostableEvent,
    pricing: PricingTable,
    mode: CostMode,
    candidates: string[]
): CostEstimate {
    return chooseCost({
        source: event.source,
        recorded: event.recordedCostUsd,
        mode,
        catalog: () => catalogEstimate(event, pricing, candidates),
    });
}

/**
 * The one recorded-cost rule, for the spend reports and the session analysis alike: a recorded list price stands
 * (`recorded`); otherwise the catalog prices the call, and a recorded metering figure (`reported`) only stands in for
 * a model the catalog cannot price. `calculate` always takes the catalog; `display` only what the agent recorded.
 */
export function chooseCost(input: {
    source: SourceId;
    recorded: number | undefined;
    mode: CostMode;
    catalog: () => CostEstimate;
}): CostEstimate {
    const { recorded, mode } = input;

    if (mode !== "calculate" && recorded !== undefined && recordedCostIsListPrice(input.source)) {
        return { costUSD: recorded, longContext: false, basis: "recorded" };
    }

    // `display` shows only what the agent recorded. A metering figure is still the agent's
    // own number there, labelled as such.
    if (mode === "display") {
        return recorded === undefined
            ? { costUSD: null, longContext: false, basis: "unpriced" }
            : { costUSD: recorded, longContext: false, basis: "reported" };
    }

    const catalog = input.catalog();

    if (catalog.costUSD === null && recorded !== undefined && mode !== "calculate") {
        return { costUSD: recorded, longContext: false, basis: "reported" };
    }

    return catalog;
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
