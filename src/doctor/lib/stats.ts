import type { HistoryEntry } from "./history";

export interface Stats {
    totalReclaimedBytes: number;
    totalActions: number;
    actionCounts: Record<string, number>;
    runsCount: number;
}

export function aggregate(entries: HistoryEntry[]): Stats {
    let totalReclaimedBytes = 0;
    const actionCounts: Record<string, number> = {};
    const runIds = new Set<string>();

    for (const entry of entries) {
        runIds.add(entry.runId);
        actionCounts[entry.action.actionId] = (actionCounts[entry.action.actionId] ?? 0) + 1;

        if (entry.action.status === "ok" && entry.action.actualReclaimedBytes != null) {
            totalReclaimedBytes += entry.action.actualReclaimedBytes;
        }
    }

    return {
        totalReclaimedBytes,
        totalActions: entries.length,
        actionCounts,
        runsCount: runIds.size,
    };
}
