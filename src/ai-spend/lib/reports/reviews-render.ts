import { formatCost, formatTokens } from "@genesiscz/utils/format";
import { createBoxTable } from "@genesiscz/utils/table";
import type { CodexAnalysis } from "./reviews";

export function renderCodexAnalysis(report: CodexAnalysis, timezone: string, passes = true): string {
    const cost = (row: { costUSD: number | null; knownCostUSD: number }) =>
        row.costUSD === null ? `unknown (${formatCost(row.knownCostUSD)} known)` : formatCost(row.costUSD);
    const models = createBoxTable(["MODEL", "REQUESTS", "LONG CONTEXT", "FAST", "TOKENS", "EST. COST"]);
    for (const row of report.models) {
        models.push([
            row.model,
            String(row.requests),
            String(row.longContextRequests),
            String(row.fastRequests),
            formatTokens(row.totalTokens),
            cost(row),
        ]);
    }
    const activities = createBoxTable(["ACTIVITY", "REQUESTS", "EST. COST"]);
    for (const row of report.activities) {
        activities.push([row.activity, String(row.requests), cost(row)]);
    }
    const parts = [models.toString(), activities.toString()];
    if (passes) {
        const table = createBoxTable(["START", "THREAD / PASS", "ACTIVITY", "EVIDENCE", "STATUS", "EST. COST"]);
        const time = (value: string) => {
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? value : date.toLocaleString("sv-SE", { timeZone: timezone });
        };
        for (const row of report.passes) {
            table.push([
                time(row.startedAt),
                `${(row.threadId ?? row.sessionId).slice(0, 8)} / ${row.taskId.slice(0, 8)}`,
                row.activity,
                row.evidence,
                row.completed ? "completed" : "incomplete",
                cost(row),
            ]);
        }
        parts.push(table.toString());
    }
    parts.push(`Total estimate: ${cost(report.totals)}`, ...report.notes);
    return parts.join("\n\n");
}
