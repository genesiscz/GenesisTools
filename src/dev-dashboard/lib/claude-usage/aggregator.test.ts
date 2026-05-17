import { describe, expect, it } from "bun:test";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { getUsageHistory, getUsageHistoryMulti } from "./aggregator";

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

describe("getUsageHistoryMulti", () => {
    it("returns one series per requested bucket, with a hint when all empty", () => {
        const db = new UsageHistoryDb(":memory:");
        try {
            const result = getUsageHistoryMulti(
                { account: "acct", buckets: ["five_hour", "seven_day", "seven_day_sonnet"], minutes: 10080 },
                db
            );

            expect(result.series.map((s) => s.bucket)).toEqual(["five_hour", "seven_day", "seven_day_sonnet"]);
            expect(result.series.every((s) => s.snapshots.length === 0)).toBe(true);
            expect(result.hint).toBe("Run 'tools claude daemon install' to start polling.");
        } finally {
            db.close();
        }
    });

    it("fills only the buckets that have data and drops the hint", () => {
        const db = new UsageHistoryDb(":memory:");
        try {
            db.recordSnapshot("acct", "five_hour", 12, new Date().toISOString());
            db.recordSnapshot("acct", "seven_day", 34, new Date().toISOString());

            const result = getUsageHistoryMulti(
                { account: "acct", buckets: ["five_hour", "seven_day", "seven_day_sonnet"], minutes: 10080 },
                db
            );

            expect(result.hint).toBeUndefined();
            const byBucket = Object.fromEntries(result.series.map((s) => [s.bucket, s.snapshots.length]));
            expect(byBucket).toEqual({ five_hour: 1, seven_day: 1, seven_day_sonnet: 0 });
        } finally {
            db.close();
        }
    });
});
