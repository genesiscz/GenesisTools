import { describe, expect, it } from "bun:test";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { getUsageHistory } from "./aggregator";

describe("getUsageHistory", () => {
    it("returns a hint when no snapshots exist", () => {
        const db = new UsageHistoryDb(":memory:");
        try {
            const result = getUsageHistory({ account: "acct", bucket: "five_hour", minutes: 1440 }, db);

            expect(result.snapshots).toEqual([]);
            expect(result.hint).toBe("Run 'tools claude daemon install' to start polling.");
        } finally {
            db.close();
        }
    });

    it("returns snapshots without a hint when data exists", () => {
        const db = new UsageHistoryDb(":memory:");
        try {
            db.recordSnapshot("acct", "five_hour", 42, new Date().toISOString());

            const result = getUsageHistory({ account: "acct", bucket: "five_hour", minutes: 1440 }, db);

            expect(result.hint).toBeUndefined();
            expect(result.snapshots).toHaveLength(1);
            expect(result.snapshots[0].utilization).toBe(42);
            expect(result.snapshots[0].accountName).toBe("acct");
        } finally {
            db.close();
        }
    });
});
