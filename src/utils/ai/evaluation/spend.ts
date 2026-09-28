import { catalogCostUsd, firstUsageDay, queryUsage, type UsageEvent } from "@genesiscz/utils/ai/usage";

/** The `app` every Jev call is booked under in the usage ledger (`src/utils/ai/evaluation/service.ts`). */
export const JEV_USAGE_APP = "jev";
/** Calls booked without a `usageLabel` (listen, watch, route, ... before they set one). */
export const UNLABELED_JEV_USE = "unlabeled";

export type JevCostBasis = "booked" | "catalog" | "unpriced";

export interface JevCall {
    at: string;
    /** `jev-typesafe` or `jev-vercel`. */
    provider: string;
    model: string;
    /** The feature that spent it, from `meta.label`. */
    label: string;
    questions?: number;
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
    /** `booked` came from the ledger row; `catalog` was priced now because the row predates the price. */
    costBasis: JevCostBasis;
}

export interface JevSpendTotal {
    calls: number;
    inputTokens: number;
    costUsd: number;
    /** Calls neither the ledger nor the catalog could price. Never counted as free. */
    unpricedCalls: number;
}

export interface JevSpendSummary {
    from: string;
    to: string;
    total: JevSpendTotal;
    byLabel: Record<string, JevSpendTotal>;
    byModel: Record<string, JevSpendTotal>;
    /** UTC day, `YYYY-MM-DD`. */
    byDay: Record<string, JevSpendTotal>;
}

function toCall(event: UsageEvent): JevCall {
    const label = typeof event.meta?.label === "string" ? event.meta.label : UNLABELED_JEV_USE;
    const questions = typeof event.meta?.questions === "number" ? event.meta.questions : undefined;
    const repriced = event.costUsd === undefined ? catalogCostUsd(event) : undefined;
    const costUsd = event.costUsd ?? repriced;
    return {
        at: event.at,
        provider: event.provider,
        model: event.modelId,
        label,
        ...(questions === undefined ? {} : { questions }),
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(costUsd === undefined ? {} : { costUsd }),
        costBasis: event.costUsd !== undefined ? "booked" : repriced !== undefined ? "catalog" : "unpriced",
    };
}

/**
 * Every Jev call in the ledger inside `[from, to)`, whichever feature made it. `from` defaults to the
 * oldest day file and `to` to now. Reads through `queryUsage`, so it sees exactly what the dashboard's
 * spend block and `tools ai-spend jev` see.
 */
export function jevCalls(window: { from?: string; to?: string } = {}): { from: string; to: string; calls: JevCall[] } {
    const to = window.to ?? new Date().toISOString();
    const from = window.from ?? firstUsageDay() ?? to;
    if (from >= to) {
        return { from, to, calls: [] };
    }

    const { events } = queryUsage({ from, to, app: JEV_USAGE_APP });
    return { from, to, calls: events.map(toCall) };
}

function emptyTotal(): JevSpendTotal {
    return { calls: 0, inputTokens: 0, costUsd: 0, unpricedCalls: 0 };
}

function add(into: Record<string, JevSpendTotal>, key: string, call: JevCall): void {
    const total = into[key] ?? emptyTotal();
    addCall(total, call);
    into[key] = total;
}

function addCall(total: JevSpendTotal, call: JevCall): void {
    total.calls++;
    total.inputTokens += call.inputTokens;
    if (call.costUsd === undefined) {
        total.unpricedCalls++;
    } else {
        total.costUsd += call.costUsd;
    }
}

/** Totals for all Jev use, split by feature, by model and by UTC day. */
export function jevSpend(window: { from?: string; to?: string } = {}): JevSpendSummary {
    const { from, to, calls } = jevCalls(window);
    const summary: JevSpendSummary = { from, to, total: emptyTotal(), byLabel: {}, byModel: {}, byDay: {} };
    for (const call of calls) {
        addCall(summary.total, call);
        add(summary.byLabel, call.label, call);
        add(summary.byModel, `${call.provider}/${call.model}`, call);
        add(summary.byDay, call.at.slice(0, 10), call);
    }

    return summary;
}
