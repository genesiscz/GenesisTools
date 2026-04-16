import { describe, expect, it } from "bun:test";
import type { HistoryEntry } from "@app/doctor/lib/history";
import { aggregate } from "@app/doctor/lib/stats";

describe("stats.aggregate", () => {
    it("sums reclaimed bytes by analyzer", () => {
        const now = new Date();
        const entries: HistoryEntry[] = [
            {
                timestamp: now.toISOString(),
                runId: "r1",
                action: { findingId: "f1", actionId: "delete", status: "ok", actualReclaimedBytes: 100 },
            },
            {
                timestamp: now.toISOString(),
                runId: "r1",
                action: { findingId: "f2", actionId: "delete", status: "ok", actualReclaimedBytes: 200 },
            },
            {
                timestamp: now.toISOString(),
                runId: "r1",
                action: { findingId: "f3", actionId: "kill", status: "ok" },
            },
        ];
        const stats = aggregate(entries);
        expect(stats.totalReclaimedBytes).toBe(300);
        expect(stats.totalActions).toBe(3);
        expect(stats.actionCounts.delete).toBe(2);
        expect(stats.actionCounts.kill).toBe(1);
    });

    it("ignores failed actions for reclaim totals", () => {
        const entries: HistoryEntry[] = [
            {
                timestamp: new Date().toISOString(),
                runId: "r1",
                action: { findingId: "f1", actionId: "delete", status: "failed", actualReclaimedBytes: 100 },
            },
        ];
        const stats = aggregate(entries);
        expect(stats.totalReclaimedBytes).toBe(0);
    });
});
