import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { removeDbFile } from "@genesiscz/utils/fs";
import { tmpdir } from "@genesiscz/utils/paths";
import { activeDeltas, atYourPace, chooseRate, paceFor, paceLabel } from "./burn-pace";
import { UsageHistoryDb } from "./history-db";

let testCounter = 0;

function getTestDbPath(): string {
    return join(tmpdir(), `claude-burn-pace-test-${Date.now()}-${++testCounter}.sqlite`);
}

function recentTimestamp(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe("activeDeltas", () => {
    test("a gap longer than the idle threshold is not a burn sample", () => {
        const deltas = activeDeltas([
            { timestamp: recentTimestamp(120), value: 10 },
            { timestamp: recentTimestamp(10), value: 60 }, // 110min apart — idle stretch
        ]);
        expect(deltas).toHaveLength(0);
    });

    test("a negative delta (reset rolled through) is not a burn sample", () => {
        const deltas = activeDeltas([
            { timestamp: recentTimestamp(20), value: 80 },
            { timestamp: recentTimestamp(10), value: 5 },
        ]);
        expect(deltas).toHaveLength(0);
    });

    test("positive deltas within the threshold become %/min rates", () => {
        const deltas = activeDeltas([
            { timestamp: recentTimestamp(20), value: 10 },
            { timestamp: recentTimestamp(10), value: 20 }, // +10% over 10min = 1%/min
        ]);
        expect(deltas).toHaveLength(1);
        expect(deltas[0]).toBeCloseTo(1, 5);
    });

    test("unsorted input is ordered before differencing", () => {
        const deltas = activeDeltas([
            { timestamp: recentTimestamp(10), value: 20 },
            { timestamp: recentTimestamp(20), value: 10 },
        ]);
        expect(deltas).toHaveLength(1);
        expect(deltas[0]).toBeGreaterThan(0);
    });
});

describe("chooseRate", () => {
    const now = new Date();

    test("prefers the active-burn median once there are enough samples", () => {
        const choice = chooseRate([1, 2, 3], [], now);
        expect(choice?.basis).toBe("active");
        expect(choice?.ratePctPerMinute).toBe(2);
    });

    test("falls back to the rolling window below the active-sample floor", () => {
        const samples = [
            { timestamp: recentTimestamp(30), value: 10 },
            { timestamp: recentTimestamp(0), value: 40 },
        ];
        const choice = chooseRate([5], samples, now);
        expect(choice?.basis).toBe("rolling");
    });

    test("null when neither rate is positive", () => {
        expect(chooseRate([], [], now)).toBeNull();
    });
});

describe("paceLabel", () => {
    test("formats minutes as an approximate duration", () => {
        expect(paceLabel(35)).toBe("≈35m");
    });
});

describe("paceFor", () => {
    let db: UsageHistoryDb;
    let dbPath: string;

    beforeEach(() => {
        ClaudeDatabase.closeInstance();
        dbPath = getTestDbPath();
        db = new UsageHistoryDb(dbPath);
    });

    afterEach(() => {
        db.close();
        removeDbFile(dbPath);
    });

    test("undefined with no history", () => {
        expect(paceFor(db, { accountName: "foltyn", bucket: "five_hour", utilizationPct: 50 })).toBeUndefined();
    });

    test("reports the active basis when active samples dominate", () => {
        for (const [minutesAgo, value] of [
            [40, 10],
            [30, 20],
            [20, 30],
            [10, 40],
        ] as const) {
            db.recordSnapshot("foltyn", "five_hour", value, recentTimestamp(minutesAgo));
        }

        const result = paceFor(db, {
            accountName: "foltyn",
            bucket: "five_hour",
            utilizationPct: 40,
            scope: "per-account",
        });

        expect(result?.basis).toBe("active");
        expect(result?.label).toMatch(/^≈/);
    });

    test("per-account scope ignores other accounts' history", () => {
        for (const [minutesAgo, value] of [
            [40, 10],
            [30, 20],
            [20, 30],
            [10, 40],
        ] as const) {
            db.recordSnapshot("other", "five_hour", value, recentTimestamp(minutesAgo));
        }

        expect(
            paceFor(db, {
                accountName: "foltyn",
                bucket: "five_hour",
                utilizationPct: 50,
                scope: "per-account",
            })
        ).toBeUndefined();
    });

    test("pooled scope borrows another account's history for a fresh account", () => {
        for (const [minutesAgo, value] of [
            [40, 10],
            [30, 20],
            [20, 30],
            [10, 40],
        ] as const) {
            db.recordSnapshot("other", "five_hour", value, recentTimestamp(minutesAgo));
        }

        const result = paceFor(db, {
            accountName: "foltyn",
            bucket: "five_hour",
            utilizationPct: 50,
            scope: "pooled",
        });

        expect(result?.basis).toBe("active");
    });

    test("pooled scope does not mix bucket kinds", () => {
        for (const [minutesAgo, value] of [
            [40, 10],
            [30, 20],
            [20, 30],
            [10, 40],
        ] as const) {
            db.recordSnapshot("other", "seven_day", value, recentTimestamp(minutesAgo));
        }

        expect(
            paceFor(db, { accountName: "foltyn", bucket: "five_hour", utilizationPct: 50, scope: "pooled" })
        ).toBeUndefined();
    });

    test("atYourPace returns just the label", () => {
        for (const [minutesAgo, value] of [
            [40, 10],
            [30, 20],
            [20, 30],
            [10, 40],
        ] as const) {
            db.recordSnapshot("foltyn", "five_hour", value, recentTimestamp(minutesAgo));
        }

        expect(atYourPace(db, { accountName: "foltyn", bucket: "five_hour", utilizationPct: 40 })).toMatch(/^≈/);
    });
});
