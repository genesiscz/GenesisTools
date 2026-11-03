import { costOf, priceFor, resolvePrice } from "../pricing";
import type { PricingTable } from "../types";
import type { CostMode, SpendEvent } from "./types";

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
 * Sources whose recorded cost is NOT the list price.
 *
 * Grok Build records `costUsdTicks` per turn, and it is the CLI's own metering, not xAI's list
 * rate: over the 44 grok worker turn logs on this machine, recorded / list was about 1.00-1.13
 * until 2026-09-04, then 0.17, 0.20, and 0.34 on every turn since 2026-09-16 (four grok-4.7 turns
 * fit 0.34 x $2 / $0.50 / $6 exactly; rl-grok-pr512 recorded $2.44 against a $7.18 list price,
 * 2026-10-14). Pricing grok from the catalog keeps "API-equivalent" meaning list price; the
 * recorded figure stays a fallback for a model the catalog cannot price.
 */
const RECORDED_COST_IS_METERING: ReadonlySet<string> = new Set(["grok"]);

export function recordedCostIsListPrice(source: string): boolean {
    return !RECORDED_COST_IS_METERING.has(source);
}

export function catalogEstimate(event: CostableEvent, pricing: PricingTable, candidates: string[]): CostEstimate {
    for (const model of candidates) {
        const entry = priceFor(model, pricing);
        if (!entry) {
            continue;
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
        const price = resolvePrice(entry, context);
        const short = resolvePrice(entry, { ...context, contextTokens: 0 });
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
    event: CostableEvent,
    pricing: PricingTable,
    mode: CostMode,
    candidates: string[]
): CostEstimate {
    const recorded = event.recordedCostUsd;
    const listPrice = recordedCostIsListPrice(event.source);

    if (mode !== "calculate" && recorded !== undefined && listPrice) {
        return { costUSD: recorded, longContext: false, basis: "recorded" };
    }

    // `display` shows only what the agent recorded. A metering figure is still the agent's
    // own number there, labelled as such.
    if (mode === "display") {
        return recorded === undefined
            ? { costUSD: null, longContext: false, basis: "unpriced" }
            : { costUSD: recorded, longContext: false, basis: "reported" };
    }

    const catalog = catalogEstimate(event, pricing, candidates);

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
