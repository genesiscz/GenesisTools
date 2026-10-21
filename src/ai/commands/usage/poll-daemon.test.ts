import { describe, expect, test } from "bun:test";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/usage-poll/types";
import { anthropicRows, notifiableWindows, rowsOfAnswer, sessionRowsArgv } from "./poll-daemon";

/**
 * The daemon fans one poll round out to three consumers with different rules: threshold
 * notifications, the anthropic extra-usage tracker, and the warmup rules. All three must
 * ignore a stale row, which is a REPLAY of an older successful fetch — acting on one
 * re-fires a threshold that was already handled and re-arms a warmup that already ran.
 */

function snapshot(overrides: Partial<AccountUsageSnapshot> = {}): AccountUsageSnapshot {
    return {
        provider: "anthropic-sub",
        accountId: "acc_work",
        accountName: "work",
        fetchedAt: "2026-09-04T18:00:00.000Z",
        limits: [
            {
                key: "five_hour",
                label: "Session (5h)",
                kind: "session",
                percentUsed: 42,
                resetsAt: "2026-09-04T20:00:00.000Z",
            },
        ],
        ...overrides,
    };
}

describe("notifiableWindows", () => {
    test("flattens every window of a healthy snapshot", () => {
        expect(notifiableWindows([snapshot()])).toEqual([
            {
                // The immutable id rides along: the notification tracker keys on it,
                // because two accounts may legitimately share a name (PR #368 t4).
                accountId: "acc_work",
                accountName: "work",
                key: "five_hour",
                kind: "session",
                label: "Session (5h)",
                utilization: 42,
                resetsAt: "2026-09-04T20:00:00.000Z",
            },
        ]);
    });

    test("a stale replay notifies nothing", () => {
        const stale = snapshot({ stale: { lastSuccessAt: "2026-09-04T17:00:00.000Z", reason: "429" } });

        expect(notifiableWindows([stale])).toEqual([]);
    });

    test("an error row notifies nothing", () => {
        expect(notifiableWindows([snapshot({ error: "boom", limits: [] })])).toEqual([]);
    });

    test("a non-finite percentage is skipped rather than notified as NaN", () => {
        const broken = snapshot({
            limits: [{ key: "five_hour", label: "Session (5h)", kind: "session", percentUsed: Number.NaN }],
        });

        expect(notifiableWindows([broken])).toEqual([]);
    });
});

describe("anthropicRows", () => {
    test("keeps only anthropic snapshots and re-wraps the raw payload", () => {
        const usage = {
            five_hour: { utilization: 42, resets_at: null },
            seven_day: { utilization: 11, resets_at: null },
        };
        const rows = anthropicRows([
            snapshot({ native: usage }),
            snapshot({ provider: "grok-sub", accountName: "personal" }),
        ]);

        expect(rows.map((r) => r.accountName)).toEqual(["work"]);
        expect(rows[0].usage).toEqual(usage);
    });

    test("a stale anthropic row survives the mapping so the caller can filter it", () => {
        const rows = anthropicRows([snapshot({ stale: { lastSuccessAt: "2026-09-04T17:00:00.000Z", reason: "429" } })]);

        expect(rows[0].stale?.reason).toBe("429");
        expect(rows.filter((r) => !r.stale)).toEqual([]);
    });
});

describe("sessionRowsArgv", () => {
    test("the child and the hub server get the same cache-safe command, providers included", () => {
        expect(sessionRowsArgv({ hours: 24, minRows: 10 })).toEqual([
            "ai",
            "usage",
            "sessions",
            "--json",
            "--fresh",
            "--no-cache-write",
            "--journal-only",
            "--hours",
            "24",
            "--min",
            "10",
        ]);
        expect(sessionRowsArgv({ providers: ["claude", "codex"], limit: 5 })).toEqual([
            "ai",
            "usage",
            "sessions",
            "--json",
            "--fresh",
            "--no-cache-write",
            "--journal-only",
            "--provider",
            "claude",
            "codex",
            "--limit",
            "5",
        ]);
    });

    test("rowsOfAnswer reads the rows and refuses an answer without them", () => {
        expect(rowsOfAnswer(`{"rows":[{"sessionId":"a"}],"fetchedAt":1}`)?.map((row) => row.sessionId)).toEqual(["a"]);
        expect(rowsOfAnswer(`{"error":"busy"}`)).toBeNull();
        expect(() => rowsOfAnswer("not json")).toThrow();
    });
});
