import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { removeDbFile } from "@genesiscz/utils/fs";
import { tmpdir } from "@genesiscz/utils/paths";
import { UsageLimitsDb } from "./limits-db";

let testCounter = 0;

function getTestDbPath(): string {
    return join(tmpdir(), `ai-usage-limits-test-${Date.now()}-${++testCounter}.sqlite`);
}

/** Generate a recent ISO timestamp (minutesAgo from now) */
function recentTimestamp(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe("UsageLimitsDb", () => {
    let db: UsageLimitsDb;
    let dbPath: string;

    beforeEach(() => {
        ClaudeDatabase.closeInstance();
        dbPath = getTestDbPath();
        db = new UsageLimitsDb(dbPath);
    });

    afterEach(() => {
        db.close();
        removeDbFile(dbPath);
    });

    test("creates database and tables on init", () => {
        expect(existsSync(dbPath)).toBe(true);
    });

    test("records a snapshot", () => {
        db.recordSnapshot("work", "five_hour", 42.5, recentTimestamp(5));
        const snapshots = db.getSnapshots("work", "five_hour", 60);
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].utilization).toBe(42.5);
    });

    test("recordIfChanged skips duplicate values", () => {
        db.recordSnapshot("work", "five_hour", 42.5, recentTimestamp(5));
        const inserted = db.recordIfChanged("work", "five_hour", 42.5, null);
        expect(inserted).toBe(false);
        expect(db.getSnapshots("work", "five_hour", 60)).toHaveLength(1);
    });

    test("recordIfChanged inserts when value changes", () => {
        db.recordSnapshot("work", "five_hour", 42.5, recentTimestamp(5));
        const inserted = db.recordIfChanged("work", "five_hour", 43.0, null);
        expect(inserted).toBe(true);
        expect(db.getSnapshots("work", "five_hour", 60)).toHaveLength(2);
    });

    test("getSnapshots returns data in time order for graphing", () => {
        db.recordSnapshot("work", "five_hour", 10, recentTimestamp(3));
        db.recordSnapshot("work", "five_hour", 20, recentTimestamp(2));
        db.recordSnapshot("work", "five_hour", 30, recentTimestamp(1));
        const snapshots = db.getSnapshots("work", "five_hour", 60);
        expect(snapshots[0].utilization).toBe(10);
        expect(snapshots[2].utilization).toBe(30);
    });

    test("getLatest returns most recent snapshot per bucket", () => {
        db.recordSnapshot("work", "five_hour", 10, recentTimestamp(2));
        db.recordSnapshot("work", "five_hour", 20, recentTimestamp(1));
        const latest = db.getLatest("work", "five_hour");
        expect(latest?.utilization).toBe(20);
    });

    test("pruneOlderThan removes old data", () => {
        const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        db.recordSnapshot("work", "five_hour", 10, oldDate);
        db.recordSnapshot("work", "five_hour", 20, new Date().toISOString());

        db.pruneOlderThan(30);
        const all = db.getSnapshots("work", "five_hour", 60 * 24 * 60);
        expect(all).toHaveLength(1);
        expect(all[0].utilization).toBe(20);
    });

    test("getAllAccountBuckets lists distinct account+bucket pairs", () => {
        db.recordSnapshot("work", "five_hour", 10, recentTimestamp(5));
        db.recordSnapshot("work", "seven_day", 15, recentTimestamp(5));
        db.recordSnapshot("personal", "five_hour", 5, recentTimestamp(5));

        const pairs = db.getAllAccountBuckets();
        expect(pairs).toHaveLength(3);
    });

    test("recordSnapshotV2 stores severity + scope_model", () => {
        db.recordSnapshotV2("work", "five_hour", 42, recentTimestamp(5), {
            resetsAt: null,
            severity: "warning",
            scopeModel: null,
        });
        const latest = db.getLatest("work", "five_hour");
        expect(latest?.severity).toBe("warning");
        expect(latest?.scopeModel).toBeNull();
    });

    test("recordIfChangedV2 inserts when severity changes even if percent equal", () => {
        db.recordSnapshotV2("work", "five_hour", 80, recentTimestamp(5), {
            resetsAt: null,
            severity: "normal",
            scopeModel: null,
        });
        const inserted = db.recordIfChangedV2("work", "five_hour", 80, {
            resetsAt: null,
            severity: "warning",
            scopeModel: null,
        });
        expect(inserted).toBe(true);
        expect(db.getSnapshots("work", "five_hour", 60)).toHaveLength(2);
    });

    test("recordIfChangedV2 skips when percent AND severity unchanged", () => {
        db.recordSnapshotV2("work", "five_hour", 80, recentTimestamp(5), {
            resetsAt: null,
            severity: "warning",
            scopeModel: null,
        });
        const inserted = db.recordIfChangedV2("work", "five_hour", 80, {
            resetsAt: null,
            severity: "warning",
            scopeModel: null,
        });
        expect(inserted).toBe(false);
    });

    test("recordIfChangedV2 skips when resets_at differs only by sub-second precision", () => {
        db.recordSnapshotV2("work", "seven_day", 100, recentTimestamp(5), {
            resetsAt: "2026-07-02T19:00:00.245191+00:00",
            severity: "critical",
            scopeModel: null,
        });
        const inserted = db.recordIfChangedV2("work", "seven_day", 100, {
            resetsAt: "2026-07-02T19:00:00.194135+00:00",
            severity: "critical",
            scopeModel: null,
        });
        expect(inserted).toBe(false);
        expect(db.getSnapshots("work", "seven_day", 60)).toHaveLength(1);
    });

    test("recordIfChangedV2 skips when resets_at jitters across a whole-second boundary", () => {
        // Observed in production: the API's resets_at drifts by up to ~1.6s between polls
        // even when the reset window hasn't moved, and that drift can straddle a whole
        // second (e.g. 03:59:59.9 vs 04:00:00.1) — a floor-to-second comparison would
        // wrongly treat this as a change.
        db.recordSnapshotV2("work", "seven_day", 100, recentTimestamp(5), {
            resetsAt: "2026-07-02T19:00:00.900Z",
            severity: "critical",
            scopeModel: null,
        });
        const inserted = db.recordIfChangedV2("work", "seven_day", 100, {
            resetsAt: "2026-07-02T19:00:01.100Z",
            severity: "critical",
            scopeModel: null,
        });
        expect(inserted).toBe(false);
        expect(db.getSnapshots("work", "seven_day", 60)).toHaveLength(1);
    });

    test("recordIfChangedV2 inserts when resets_at changes well beyond jitter tolerance", () => {
        db.recordSnapshotV2("work", "seven_day", 100, recentTimestamp(5), {
            resetsAt: "2026-07-02T19:00:00.000Z",
            severity: "critical",
            scopeModel: null,
        });
        const inserted = db.recordIfChangedV2("work", "seven_day", 100, {
            resetsAt: "2026-07-02T19:00:30.000Z",
            severity: "critical",
            scopeModel: null,
        });
        expect(inserted).toBe(true);
        expect(db.getSnapshots("work", "seven_day", 60)).toHaveLength(2);
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
        // Passing an explicit dbPath (as the outer beforeEach does) bypasses the
        // ClaudeDatabase singleton — each `new UsageLimitsDb(dbPath)` then gets its
        // own Database object, so a spy on the first would never see the second's
        // calls. Use the singleton path (no dbPath arg) so both constructions share
        // the exact same connection the WeakSet dedup is keyed on.
        ClaudeDatabase.closeInstance();
        ClaudeDatabase.getInstance(dbPath);

        const execSpy: string[] = [];
        const first = new UsageLimitsDb();
        // biome-ignore lint/complexity/useLiteralKeys: bracket access deliberately bypasses the private-field check
        const rawDb = first["claudeDb"].getDb();
        const originalExec = rawDb.exec.bind(rawDb);
        rawDb.exec = (sql: string) => {
            execSpy.push(sql);
            return originalExec(sql);
        };

        const firstCount = execSpy.length;
        new UsageLimitsDb();
        expect(execSpy.length).toBe(firstCount);

        ClaudeDatabase.closeInstance();
    });

    test("ensureSchema is idempotent across re-opens (PRAGMA-guarded ALTERs)", () => {
        db.recordSnapshotV2("work", "five_hour", 10, recentTimestamp(5), {
            resetsAt: null,
            severity: "normal",
            scopeModel: null,
        });
        db.close();

        // Re-open same file — ensureSchema runs again; ALTERs must be guarded.
        const db2 = new UsageLimitsDb(dbPath);
        const latest = db2.getLatest("work", "five_hour");
        expect(latest?.utilization).toBe(10);
        db2.close();
    });

    describe("provider column", () => {
        test("a read without provider still returns rows written before the column existed", () => {
            db.recordSnapshot("work", "five_hour", 42, recentTimestamp(5));

            const latest = db.getLatest("work", "five_hour");

            expect(latest?.provider).toBe("anthropic-sub");
            expect(db.getSnapshots("work", "five_hour", 60)).toHaveLength(1);
        });

        test("a provider filter hides another provider's rows", () => {
            db.recordSnapshotV2("work", "primary", 12, recentTimestamp(5), {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "openai-sub",
                kind: "session",
            });
            db.recordSnapshot("work", "five_hour", 42, recentTimestamp(5));

            expect(db.getSnapshots("work", "five_hour", 60, "openai-sub")).toHaveLength(0);
            expect(db.getSnapshots("work", "primary", 60, "openai-sub")).toHaveLength(1);
            expect(db.getLatest("work", "five_hour", "anthropic-sub")?.utilization).toBe(42);
            expect(db.getAllAccountBuckets("openai-sub")).toEqual([
                { accountName: "work", bucket: "primary", provider: "openai-sub" },
            ]);
        });

        test("recordIfChangedV2 dedups per provider, not across providers", () => {
            db.recordSnapshotV2("work", "primary", 50, recentTimestamp(5), {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "openai-sub",
            });

            const sameProvider = db.recordIfChangedV2("work", "primary", 50, {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "openai-sub",
            });
            const otherProvider = db.recordIfChangedV2("work", "primary", 50, {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "grok-sub",
            });

            expect(sameProvider).toBe(false);
            expect(otherProvider).toBe(true);
        });

        test("credit windows keep their money columns", () => {
            db.recordSnapshotV2("shop", "monthly", 30, recentTimestamp(5), {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "grok-sub",
                kind: "credit",
                money: { usedMinor: 900, limitMinor: 3000, currency: "USD" },
            });

            const latest = db.getLatest("shop", "monthly", "grok-sub");

            expect(latest).toMatchObject({
                kind: "credit",
                moneyUsedMinor: 900,
                moneyLimitMinor: 3000,
                moneyCurrency: "USD",
            });
        });

        test("spend rows carry a provider and filter by it", () => {
            const spend = {
                used_minor: 500,
                used_currency: "USD",
                used_exponent: 2,
                limit_minor: 5000,
                limit_exponent: 2,
                percent: 10,
                severity: "normal",
                enabled: true,
                cap_minor: 5000,
                cap_currency: "USD",
            };

            expect(db.recordSpendIfChanged("work", spend)).toBe(true);

            expect(db.getLatestSpend("work")?.used_minor).toBe(500);
            expect(db.getLatestSpend("work", "anthropic-sub")?.used_minor).toBe(500);
            expect(db.getLatestSpend("work", "grok-sub")).toBeNull();
        });

        test("the provider migration is idempotent across re-opens of the same file", () => {
            db.recordSnapshotV2("work", "five_hour", 10, recentTimestamp(5), {
                resetsAt: null,
                severity: "normal",
                scopeModel: null,
            });
            db.close();

            const db2 = new UsageLimitsDb(dbPath);
            db2.recordSnapshotV2("personal", "primary", 20, recentTimestamp(4), {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "openai-sub",
            });

            expect(db2.getLatest("work", "five_hour")?.provider).toBe("anthropic-sub");
            expect(db2.getLatest("personal", "primary", "openai-sub")?.utilization).toBe(20);
            db2.close();
        });
    });

    describe("getSeries", () => {
        test("returns one entry per account and window key, points in time order", () => {
            db.recordSnapshot("work", "five_hour", 10, recentTimestamp(30));
            db.recordSnapshot("work", "five_hour", 20, recentTimestamp(20));
            db.recordSnapshot("personal", "five_hour", 5, recentTimestamp(25));

            const series = db.getSeries({
                from: recentTimestamp(60),
                to: recentTimestamp(0),
            });

            expect(series).toHaveLength(2);
            const work = series.find((s) => s.account === "work");
            expect(work?.key).toBe("five_hour");
            expect(work?.points.map((p) => p.percent)).toEqual([10, 20]);
            expect(series.find((s) => s.account === "personal")?.points).toHaveLength(1);
        });

        test("provider openai-sub hides the anthropic rows", () => {
            db.recordSnapshot("work", "five_hour", 10, recentTimestamp(30));
            db.recordSnapshotV2("work", "primary", 44, recentTimestamp(20), {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "openai-sub",
            });

            const series = db.getSeries({
                provider: "openai-sub",
                from: recentTimestamp(60),
                to: recentTimestamp(0),
            });

            expect(series).toEqual([
                { account: "work", key: "primary", points: [{ t: expect.any(String), percent: 44 }] },
            ]);
        });

        test("accounts and keys narrow the result", () => {
            db.recordSnapshot("work", "five_hour", 10, recentTimestamp(30));
            db.recordSnapshot("work", "seven_day", 11, recentTimestamp(30));
            db.recordSnapshot("personal", "five_hour", 12, recentTimestamp(30));

            const series = db.getSeries({
                accounts: ["work"],
                keys: ["five_hour"],
                from: recentTimestamp(60),
                to: recentTimestamp(0),
            });

            expect(series).toHaveLength(1);
            expect(series[0]).toMatchObject({ account: "work", key: "five_hour" });
        });

        test("step keeps the last sample of each bucket", () => {
            const base = Date.parse(recentTimestamp(60));
            db.recordSnapshot("work", "five_hour", 1, new Date(base).toISOString());
            db.recordSnapshot("work", "five_hour", 2, new Date(base + 10_000).toISOString());
            db.recordSnapshot("work", "five_hour", 3, new Date(base + 70_000).toISOString());

            const series = db.getSeries({
                from: recentTimestamp(120),
                to: recentTimestamp(0),
                step: 60_000,
            });

            expect(series[0].points.map((p) => p.percent)).toEqual([2, 3]);
        });
    });

    describe("renameAccount", () => {
        test("moves every usage row to the new name", () => {
            db.recordSnapshot("old", "five_hour", 42, recentTimestamp(5));
            db.recordSnapshot("old", "seven_day", 10, recentTimestamp(4));

            const moved = db.renameAccount("old", "new");

            expect(moved).toBe(2);
            expect(db.getSnapshots("new", "five_hour", 60)).toHaveLength(1);
            expect(db.getSnapshots("old", "five_hour", 60)).toHaveLength(0);
        });

        test("leaves other accounts untouched", () => {
            db.recordSnapshot("old", "five_hour", 42, recentTimestamp(5));
            db.recordSnapshot("keep", "five_hour", 7, recentTimestamp(5));

            db.renameAccount("old", "new");

            expect(db.getSnapshots("keep", "five_hour", 60)).toHaveLength(1);
        });

        test("an unknown name moves nothing rather than throwing", () => {
            expect(db.renameAccount("nobody", "new")).toBe(0);
        });
    });
});
