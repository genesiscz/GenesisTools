import type { PricingTable } from "../types";
import { periodFieldName, periodKey, zonedDay } from "./dates";
import { asRecord } from "./jsonl";
import { buildCodexAnalysis } from "./reviews";
import type { CostMode, PeriodGrain, SpendEvent } from "./types";

/** Keep legacy token columns, but never render an incomplete dollar subtotal as a complete cost. */
export function addCodexPricingCoverage(
    report: Record<string, unknown>,
    events: SpendEvent[],
    pricing: PricingTable,
    mode: CostMode,
    kind: PeriodGrain | "session",
    timezone: string
): void {
    const analysis = buildCodexAnalysis(events, pricing, mode);
    report.analysis = analysis;
    const totals = asRecord(report.totals);
    if (totals) {
        totals.costUSD = analysis.totals.costUSD;
        totals.knownCostUSD = analysis.totals.knownCostUSD;
        totals.unpricedEvents = analysis.totals.unpricedEvents;
    }

    const groups = new Map<string, SpendEvent[]>();
    for (const event of events) {
        const key = kind === "session" ? event.sessionId : periodKey(zonedDay(event.timestamp, timezone), kind);
        const group = groups.get(key) ?? [];
        group.push(event);
        groups.set(key, group);
    }

    const rows = report[kind === "session" ? "sessions" : kind];
    if (!Array.isArray(rows)) {
        return;
    }

    for (const value of rows) {
        const row = asRecord(value);
        if (!row) {
            continue;
        }

        const key = String(row[kind === "session" ? "sessionId" : periodFieldName(kind)]);
        const per = buildCodexAnalysis(groups.get(key) ?? [], pricing, mode);
        row.costUSD = per.totals.costUSD;
        row.knownCostUSD = per.totals.knownCostUSD;
        row.unpricedEvents = per.totals.unpricedEvents;
        const models = asRecord(row.models);
        row.modelBreakdowns = per.models.map((model) => ({
            ...model,
            modelName: model.model,
            cost: model.costUSD,
        }));

        for (const model of per.models) {
            const entry = models && asRecord(models[model.model]);
            if (entry) {
                entry.costUSD = model.costUSD;
                entry.priced = model.unpricedEvents === 0;
            }
        }
    }
}
