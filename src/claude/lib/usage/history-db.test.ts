import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeDatabase } from "@app/utils/claude/database";
import { removeDbFile } from "@app/utils/fs";
import { tmpdir } from "@app/utils/paths";
import { UsageHistoryDb } from "./history-db";

let testCounter = 0;

function getTestDbPath(): string {
    return join(tmpdir(), `claude-usage-test-${Date.now()}-${++testCounter}.sqlite`);
}

/** Generate a recent ISO timestamp (minutesAgo from now) */
function recentTimestamp(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe("UsageHistoryDb", () => {
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

    test("creates database and tables on init", () => {
        expect(existsSync(dbPath)).toBe(true);
    });

    test("records a snapshot", () => {
        db.recordSnapshot("livinka", "five_hour", 42.5, recentTimestamp(5));
        const snapshots = db.getSnapshots("livinka", "five_hour", 60);
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].utilization).toBe(42.5);
    });

    test("recordIfChanged skips duplicate values", () => {
        db.recordSnapshot("livinka", "five_hour", 42.5, recentTimestamp(5));
        const inserted = db.recordIfChanged("livinka", "five_hour", 42.5, null);
        expect(inserted).toBe(false);
        expect(db.getSnapshots("livinka", "five_hour", 60)).toHaveLength(1);
    });

    test("recordIfChanged inserts when value changes", () => {
        db.recordSnapshot("livinka", "five_hour", 42.5, recentTimestamp(5));
        const inserted = db.recordIfChanged("livinka", "five_hour", 43.0, null);
        expect(inserted).toBe(true);
        expect(db.getSnapshots("livinka", "five_hour", 60)).toHaveLength(2);
    });

    test("getSnapshots returns data in time order for graphing", () => {
        db.recordSnapshot("livinka", "five_hour", 10, recentTimestamp(3));
        db.recordSnapshot("livinka", "five_hour", 20, recentTimestamp(2));
        db.recordSnapshot("livinka", "five_hour", 30, recentTimestamp(1));
        const snapshots = db.getSnapshots("livinka", "five_hour", 60);
        expect(snapshots[0].utilization).toBe(10);
        expect(snapshots[2].utilization).toBe(30);
    });

    test("getLatest returns most recent snapshot per bucket", () => {
        db.recordSnapshot("livinka", "five_hour", 10, recentTimestamp(2));
        db.recordSnapshot("livinka", "five_hour", 20, recentTimestamp(1));
        const latest = db.getLatest("livinka", "five_hour");
        expect(latest?.utilization).toBe(20);
    });

    test("pruneOlderThan removes old data", () => {
        const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        db.recordSnapshot("livinka", "five_hour", 10, oldDate);
        db.recordSnapshot("livinka", "five_hour", 20, new Date().toISOString());

        db.pruneOlderThan(30);
        const all = db.getSnapshots("livinka", "five_hour", 60 * 24 * 60);
        expect(all).toHaveLength(1);
        expect(all[0].utilization).toBe(20);
    });

    test("getAllAccountBuckets lists distinct account+bucket pairs", () => {
        db.recordSnapshot("livinka", "five_hour", 10, recentTimestamp(5));
        db.recordSnapshot("livinka", "seven_day", 15, recentTimestamp(5));
        db.recordSnapshot("personal", "five_hour", 5, recentTimestamp(5));

        const pairs = db.getAllAccountBuckets();
        expect(pairs).toHaveLength(3);
    });

    test("recordSnapshotV2 stores severity + scope_model", () => {
        db.recordSnapshotV2("livinka", "five_hour", 42, recentTimestamp(5), {
            resetsAt: null,
            severity: "warning",
            scopeModel: null,
        });
        const latest = db.getLatest("livinka", "five_hour");
        expect(latest?.severity).toBe("warning");
        expect(latest?.scopeModel).toBeNull();
    });

    test("recordIfChangedV2 inserts when severity changes even if percent equal", () => {
        db.recordSnapshotV2("livinka", "five_hour", 80, recentTimestamp(5), {
            resetsAt: null,
            severity: "normal",
            scopeModel: null,
        });
        const inserted = db.recordIfChangedV2("livinka", "five_hour", 80, {
            resetsAt: null,
            severity: "warning",
            scopeModel: null,
        });
        expect(inserted).toBe(true);
        expect(db.getSnapshots("livinka", "five_hour", 60)).toHaveLength(2);
    });

    test("recordIfChangedV2 skips when percent AND severity unchanged", () => {
        db.recordSnapshotV2("livinka", "five_hour", 80, recentTimestamp(5), {
            resetsAt: null,
            severity: "warning",
            scopeModel: null,
        });
        const inserted = db.recordIfChangedV2("livinka", "five_hour", 80, {
            resetsAt: null,
            severity: "warning",
            scopeModel: null,
        });
        expect(inserted).toBe(false);
    });

    test("recordIfChangedV2 skips when resets_at differs only by sub-second precision", () => {
        db.recordSnapshotV2("livinka", "seven_day", 100, recentTimestamp(5), {
            resetsAt: "2026-07-02T19:00:00.245191+00:00",
            severity: "critical",
            scopeModel: null,
        });
        const inserted = db.recordIfChangedV2("livinka", "seven_day", 100, {
            resetsAt: "2026-07-02T19:00:00.194135+00:00",
            severity: "critical",
            scopeModel: null,
        });
        expect(inserted).toBe(false);
        expect(db.getSnapshots("livinka", "seven_day", 60)).toHaveLength(1);
    });

    test("recordIfChangedV2 skips when resets_at jitters across a whole-second boundary", () => {
        // Observed in production: the API's resets_at drifts by up to ~1.6s between polls
        // even when the reset window hasn't moved, and that drift can straddle a whole
        // second (e.g. 03:59:59.9 vs 04:00:00.1) — a floor-to-second comparison would
        // wrongly treat this as a change.
        db.recordSnapshotV2("livinka", "seven_day", 100, recentTimestamp(5), {
            resetsAt: "2026-07-02T19:00:00.900Z",
            severity: "critical",
            scopeModel: null,
        });
        const inserted = db.recordIfChangedV2("livinka", "seven_day", 100, {
            resetsAt: "2026-07-02T19:00:01.100Z",
            severity: "critical",
            scopeModel: null,
        });
        expect(inserted).toBe(false);
        expect(db.getSnapshots("livinka", "seven_day", 60)).toHaveLength(1);
    });

    test("recordIfChangedV2 inserts when resets_at changes well beyond jitter tolerance", () => {
        db.recordSnapshotV2("livinka", "seven_day", 100, recentTimestamp(5), {
            resetsAt: "2026-07-02T19:00:00.000Z",
            severity: "critical",
            scopeModel: null,
        });
        const inserted = db.recordIfChangedV2("livinka", "seven_day", 100, {
            resetsAt: "2026-07-02T19:00:30.000Z",
            severity: "critical",
            scopeModel: null,
        });
        expect(inserted).toBe(true);
        expect(db.getSnapshots("livinka", "seven_day", 60)).toHaveLength(2);
    });

    test("recordSpendIfChanged writes a row and skips duplicates", () => {
        const spend = {
            used_minor: 1234,
            used_currency: "EUR",
            used_exponent: 2,
            limit_minor: 15000,
            limit_exponent: 2,
            percent: 8,
            severity: "normal",
            enabled: true,
            cap_minor: 15000,
            cap_currency: "EUR",
        };
        expect(db.recordSpendIfChanged("acct", spend)).toBe(true);
        expect(db.recordSpendIfChanged("acct", spend)).toBe(false);

        const latest = db.getLatestSpend("acct");
        expect(latest).toMatchObject({ used_minor: 1234, percent: 8, severity: "normal", enabled: true });
    });

    test("getLatestSpend returns null when no spend snapshots exist", () => {
        expect(db.getLatestSpend("nobody")).toBeNull();
    });

    test("only runs ensureSchema's CREATE/ALTER statements once per underlying connection", () => {
        const execSpy: string[] = [];
        const first = new UsageHistoryDb(dbPath);
        // biome-ignore lint/complexity/useLiteralKeys: bracket access deliberately bypasses the private-field check
        const rawDb = first["claudeDb"].getDb();
        const originalExec = rawDb.exec.bind(rawDb);
        rawDb.exec = (sql: string) => {
            execSpy.push(sql);
            return originalExec(sql);
        };

        const firstCount = execSpy.length;
        new UsageHistoryDb(dbPath);
        expect(execSpy.length).toBe(firstCount);
        first.close();
    });

    test("ensureSchema is idempotent across re-opens (PRAGMA-guarded ALTERs)", () => {
        db.recordSnapshotV2("livinka", "five_hour", 10, recentTimestamp(5), {
            resetsAt: null,
            severity: "normal",
            scopeModel: null,
        });
        db.close();

        // Re-open same file — ensureSchema runs again; ALTERs must be guarded.
        const db2 = new UsageHistoryDb(dbPath);
        const latest = db2.getLatest("livinka", "five_hour");
        expect(latest?.utilization).toBe(10);
        db2.close();
    });
});
