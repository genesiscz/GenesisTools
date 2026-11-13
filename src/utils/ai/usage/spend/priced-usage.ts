import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { spendDriver } from "./drivers";
import { costOf, DEFAULT_PRICING, priceFor, priceForCandidates, resolvePrice } from "./pricing";
import type { CostMode, SourceId } from "./reports/types";
import type { ModelPrice, ModelPriceEntry, PricingTable, TokenTotals } from "./types";

/**
 * What one usage record costs, in the one place that composes the pricing steps: the harness's candidate ladder,
 * the catalog rules by moment, context band and service tier, and the recorded-cost rule. The spend reports, the
 * aggregate, the session analysis, the hub insights and the worker cards all ask here.
 */

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

export interface UsageToPrice {
    /** Whose candidate ladder and recorded-cost rule apply. */
    source: SourceId;
    model: string;
    /** The call's moment; an invalid date prices as "no date". */
    at?: Date | string | number;
    tokens: TokenTotals;
    /** The record sums several requests, so it takes no context band. */
    aggregate?: boolean;
    serviceTier?: string;
    recordedCostUsd?: number;
}

export interface PricedUsage extends CostEstimate {
    /** The resolved per-token rates, for what-if arithmetic; null when unpriced. */
    price: ModelPrice | null;
}

export interface PriceUsageOptions {
    /** Default `auto`. */
    mode?: CostMode;
    /** Default `DEFAULT_PRICING`, the catalog. */
    table?: PricingTable;
    /** Default: the source's ladder (`priceLadder`). */
    candidates?: readonly string[];
}

/**
 * Whether a source's recorded cost is the list price: a coding-agent harness says so through its spend driver
 * (`MonitorDriver.recordedCost`; Grok's is plan metering), and every other ccusage source records list prices.
 */
export function recordedCostIsListPrice(source: SourceId): boolean {
    return !isAccountProviderAlias(source) || spendDriver(source).recordedCost === "list-price";
}

/** The models a source's record is priced as, in order: its harness's ladder, or the model alone. */
export function priceLadder(source: SourceId, model: string): string[] {
    if (isAccountProviderAlias(source)) {
        return spendDriver(source).priceCandidates(model);
    }

    return [model];
}

function momentOf(at: UsageToPrice["at"]): Date | undefined {
    if (at === undefined) {
        return undefined;
    }

    const date = at instanceof Date ? at : new Date(at);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function catalogEstimate(usage: UsageToPrice, found: { model: string; entry: ModelPriceEntry } | null): PricedUsage {
    if (!found) {
        return { costUSD: null, longContext: false, basis: "unpriced", price: null };
    }

    const { tokens } = usage;
    // A context band bills per request. A record that sums several requests has lost their
    // lengths, so it prices at the base band rather than at the band of the SUM.
    const context = {
        at: momentOf(usage.at),
        serviceTier: usage.serviceTier,
        contextTokens: usage.aggregate ? undefined : tokens.input + tokens.cacheRead + tokens.cacheWrite,
    };
    const price = resolvePrice(found.entry, context);
    const short = resolvePrice(found.entry, { ...context, contextTokens: 0 });
    return {
        costUSD: costOf(tokens, price),
        pricingModel: found.model,
        longContext:
            price.input !== short.input ||
            price.output !== short.output ||
            price.cacheRead !== short.cacheRead ||
            price.cacheWrite !== short.cacheWrite,
        basis: "catalog",
        price,
    };
}

/**
 * The one recorded-cost rule: a recorded list price stands (`recorded`); otherwise the catalog prices the call, and a
 * recorded metering figure (`reported`) only stands in for a model the catalog cannot price. `calculate` always takes
 * the catalog; `display` only what the agent recorded.
 */
function chooseCost(input: {
    source: SourceId;
    recorded: number | undefined;
    mode: CostMode;
    catalog: PricedUsage;
}): PricedUsage {
    const { recorded, mode, catalog } = input;
    const price = catalog.price;

    if (mode !== "calculate" && recorded !== undefined && recordedCostIsListPrice(input.source)) {
        return { costUSD: recorded, longContext: false, basis: "recorded", price };
    }

    // `display` shows only what the agent recorded. A metering figure is still the agent's
    // own number there, labelled as such.
    if (mode === "display") {
        return recorded === undefined
            ? { costUSD: null, longContext: false, basis: "unpriced", price }
            : { costUSD: recorded, longContext: false, basis: "reported", price };
    }

    if (catalog.costUSD === null && recorded !== undefined && mode !== "calculate") {
        return { costUSD: recorded, longContext: false, basis: "reported", price };
    }

    return catalog;
}

/**
 * What one usage record costs and on what basis. `price` is the catalog rate the record resolves to, whatever the
 * basis, so a caller can do what-if arithmetic on it; it is null only when the catalog has no rate for the model.
 */
export function priceUsage(usage: UsageToPrice, options: PriceUsageOptions = {}): PricedUsage {
    const table = options.table ?? DEFAULT_PRICING;
    const candidates = options.candidates ?? priceLadder(usage.source, usage.model);

    return chooseCost({
        source: usage.source,
        recorded: usage.recordedCostUsd,
        mode: options.mode ?? "auto",
        catalog: catalogEstimate(usage, priceForCandidates(candidates, table)),
    });
}

/** The same usage at another model's list price: no ladder, no recorded-cost rule, standard tier. */
export function priceUsageAs(
    usage: UsageToPrice,
    model: string,
    options: Pick<PriceUsageOptions, "table"> = {}
): PricedUsage {
    const entry = priceFor(model, options.table ?? DEFAULT_PRICING);
    return catalogEstimate({ ...usage, serviceTier: undefined }, entry ? { model, entry } : null);
}
