import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DriftRow, recordDrift } from "@genesiscz/utils/ai/usage/drift/drift";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { removeDbFile } from "@genesiscz/utils/fs";
import { tmpdir } from "@genesiscz/utils/paths";
import { normalizeSeverity, UsageLimitsDb } from "./limits-db";
import { availabilitySpans } from "./series-rows";

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

    test("recordSnapshotV2 stores severity + scope_model, severity in one vocabulary", () => {
        db.recordSnapshotV2("work", "five_hour", 42, recentTimestamp(5), {
            resetsAt: null,
            severity: "warning",
            scopeModel: null,
        });
        const latest = db.getLatest("work", "five_hour");
        expect(latest?.severity).toBe("warn");
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

    test("recordIfChangedV2 records the first limited reading after a row from before the availability column", () => {
        const same = { resetsAt: null, severity: null, scopeModel: null };
        db.recordSnapshotV2("work", "five_hour", 0, recentTimestamp(5), same);
        // biome-ignore lint/complexity/useLiteralKeys: bracket access deliberately bypasses the private-field check
        db["handle"].run("UPDATE usage_snapshots SET availability = NULL");

        expect(db.recordIfChangedV2("work", "five_hour", 0, same)).toBe(true);
        expect(db.recordIfChangedV2("work", "five_hour", 0, same)).toBe(false);
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

    /**
     * A credit window with no cap reports `percentUsed` 0 forever (grok's
     * `toCreditWindow`), so dedup on utilization alone froze `getLatest`'s money at the
     * first reading while the spend kept climbing (review t15).
     */
    test("recordIfChangedV2 inserts when only the money moved", () => {
        const extras = (usedMinor: number) => ({
            resetsAt: null,
            severity: null,
            scopeModel: null,
            provider: "grok-sub",
            kind: "credit",
            money: { usedMinor, limitMinor: null, currency: "USD" },
        });

        db.recordSnapshotV2("work", "credit", 0, recentTimestamp(5), extras(100));

        expect(db.recordIfChangedV2("work", "credit", 0, extras(500))).toBe(true);
        expect(db.getLatest("work", "credit", "grok-sub")?.moneyUsedMinor).toBe(500);
    });

    // The same trap with the percentage held steady by a proportional cap rise.
    test("recordIfChangedV2 inserts when spend and cap rise together", () => {
        const extras = (usedMinor: number, limitMinor: number) => ({
            resetsAt: null,
            severity: null,
            scopeModel: null,
            provider: "grok-sub",
            kind: "credit",
            money: { usedMinor, limitMinor, currency: "USD" },
        });

        db.recordSnapshotV2("work", "credit", 50, recentTimestamp(5), extras(100, 200));

        expect(db.recordIfChangedV2("work", "credit", 50, extras(400, 800))).toBe(true);
        expect(db.getLatest("work", "credit", "grok-sub")?.moneyLimitMinor).toBe(800);
    });

    // Negative control: unchanged money still dedupes, so the 30s poll loop does not
    // append an identical row every tick.
    test("recordIfChangedV2 still skips when the money is unchanged", () => {
        const extras = {
            resetsAt: null,
            severity: null,
            scopeModel: null,
            provider: "grok-sub",
            kind: "credit",
            money: { usedMinor: 100, limitMinor: 200, currency: "USD" },
        };

        db.recordSnapshotV2("work", "credit", 50, recentTimestamp(5), extras);

        expect(db.recordIfChangedV2("work", "credit", 50, extras)).toBe(false);
    });

    // A window that carries no money at all must keep deduping as it always did.
    test("recordIfChangedV2 still skips a moneyless window with no change", () => {
        db.recordSnapshotV2("work", "five_hour", 12, recentTimestamp(5), {
            resetsAt: null,
            severity: "normal",
            scopeModel: null,
        });

        expect(
            db.recordIfChangedV2("work", "five_hour", 12, { resetsAt: null, severity: "normal", scopeModel: null })
        ).toBe(false);
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

    test("recordIfChangedV2 ignores a moving resets_at while the window is idle (0%)", () => {
        // Codex reports resets_at = poll time + window for an untouched window, so it moves
        // by the poll interval every time; anthropic flips it between null and a value.
        db.recordSnapshotV2("work", "primary", 0, recentTimestamp(5), {
            resetsAt: "2026-09-10T19:20:22.000Z",
            severity: null,
            scopeModel: null,
        });

        expect(
            db.recordIfChangedV2("work", "primary", 0, {
                resetsAt: "2026-09-10T19:24:55.000Z",
                severity: null,
                scopeModel: null,
            })
        ).toBe(false);
        expect(db.recordIfChangedV2("work", "primary", 0, { resetsAt: null, severity: null, scopeModel: null })).toBe(
            false
        );
        expect(db.getSnapshots("work", "primary", 60)).toHaveLength(1);
    });

    test("recordIfChangedV2 still records a moving resets_at once the window is in use", () => {
        db.recordSnapshotV2("work", "primary", 1, recentTimestamp(5), {
            resetsAt: "2026-09-10T19:20:22.000Z",
            severity: null,
            scopeModel: null,
        });

        expect(
            db.recordIfChangedV2("work", "primary", 1, {
                resetsAt: "2026-09-10T19:24:55.000Z",
                severity: null,
                scopeModel: null,
            })
        ).toBe(true);
        expect(db.getSnapshots("work", "primary", 60)).toHaveLength(2);
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
        expect(latest).toMatchObject({ used_minor: 1234, percent: 8, severity: "ok", enabled: true });
    });

    test("getLatestSpend returns null when no spend snapshots exist", () => {
        expect(db.getLatestSpend("nobody")).toBeNull();
    });

    /**
     * Two processes polled the same account with the same reading in two vocabularies: a
     * pre-campaign `tools claude usage` wrote the raw API `normal` / `warning`, the new
     * daemon and TUI wrote `ok` / `warn`. Each read the other's spelling as a change, so
     * `usage_snapshots` grew ~2500 rows/hour instead of ~100 and `spend_snapshots` ~840.
     */
    describe("alternating severity vocabularies", () => {
        test("normalizeSeverity folds the raw API spelling onto the neutral one", () => {
            expect(normalizeSeverity("normal")).toBe("ok");
            expect(normalizeSeverity("warning")).toBe("warn");
            expect(normalizeSeverity("critical")).toBe("critical");
            expect(normalizeSeverity("something-else")).toBe("something-else");
        });

        /**
         * The other process runs a different copy of this code, so its row reaches the table
         * without passing through this store's write path. Recording it through the store
         * would normalise it on the way in and prove nothing.
         */
        function foreignSnapshotRow(utilization: number, resetsAt: string): void {
            const foreign = new Database(dbPath);

            foreign
                .prepare(
                    `INSERT INTO usage_snapshots (timestamp, account_name, bucket, utilization, resets_at, severity)
                     VALUES (?, 'work', 'five_hour', ?, ?, 'warning')`
                )
                .run(recentTimestamp(5), utilization, resetsAt);
            foreign.close();
        }

        test("a foreign writer's spelling does not defeat the snapshot dedupe", () => {
            const resetsAt = "2026-09-05T20:00:00.000Z";

            foreignSnapshotRow(84, resetsAt);
            const record = () =>
                db.recordIfChangedV2("work", "five_hour", 84, { resetsAt, severity: "warn", scopeModel: null });

            // The foreign row has no availability (an older copy writes none), so the first poll records the
            // window as limited once; the spelling then never makes it write again.
            expect(record()).toBe(true);

            for (let i = 0; i < 9; i++) {
                expect(record()).toBe(false);
            }

            expect(db.getSnapshots("work", "five_hour", 60)).toHaveLength(2);
        });

        test("a real utilization change still lands exactly one row", () => {
            const resetsAt = "2026-09-05T20:00:00.000Z";

            db.recordSnapshotV2("work", "five_hour", 83, recentTimestamp(5), {
                resetsAt,
                severity: "warning",
                scopeModel: null,
            });

            expect(
                db.recordIfChangedV2("work", "five_hour", 84, { resetsAt, severity: "warn", scopeModel: null })
            ).toBe(true);
            expect(
                db.recordIfChangedV2("work", "five_hour", 84, { resetsAt, severity: "warn", scopeModel: null })
            ).toBe(false);

            expect(db.getSnapshots("work", "five_hour", 60).map((row) => row.utilization)).toEqual([83, 84]);
        });

        test("a foreign writer's spelling does not defeat the spend dedupe", () => {
            const spend = {
                used_minor: 0,
                used_currency: "USD",
                used_exponent: 2,
                limit_minor: null,
                limit_exponent: null,
                percent: 0,
                severity: "normal",
                enabled: true,
                cap_minor: null,
                cap_currency: null,
            };

            const foreign = new Database(dbPath);

            foreign
                .prepare(
                    `INSERT INTO spend_snapshots (timestamp, account_name, used_minor, used_currency,
                         used_exponent, percent, severity, enabled)
                     VALUES (?, 'work', 0, 'USD', 2, 0, 'normal', 1)`
                )
                .run(recentTimestamp(5));
            foreign.close();

            for (let i = 0; i < 10; i++) {
                expect(db.recordSpendIfChanged("work", { ...spend, severity: "ok" })).toBe(false);
            }
        });
    });

    /**
     * `severity` and `scope_model` are legacy columns: the `CREATE TABLE` above
     * does not declare them, so EVERY fresh store needs them added. They used to
     * be added by a bare PRAGMA-check-then-ALTER outside any transaction, which
     * two processes opening the same fresh file both passed, and the loser died on
     * `duplicate column name`. They now go through `runMigrations`, which takes the
     * write lock before it re-checks. These two cases pin the resulting schema so
     * the move cannot change what a store ends up with.
     */
    test("a fresh store still ends up with the legacy severity and scope_model columns", () => {
        const cols = new Set(
            // biome-ignore lint/complexity/useLiteralKeys: bracket access deliberately bypasses the private-field check
            (db["handle"].prepare("PRAGMA table_info(usage_snapshots)").all() as Array<{ name: string }>).map(
                (c) => c.name
            )
        );

        expect(cols.has("severity")).toBe(true);
        expect(cols.has("scope_model")).toBe(true);
    });

    test("a store predating both columns gains them on open, keeping its rows", () => {
        const legacyPath = getTestDbPath();
        const seed = new Database(legacyPath);
        seed.exec(`
            CREATE TABLE usage_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                account_name TEXT NOT NULL,
                bucket TEXT NOT NULL,
                utilization REAL NOT NULL,
                resets_at TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        seed.run("INSERT INTO usage_snapshots (timestamp, account_name, bucket, utilization) VALUES (?, ?, ?, ?)", [
            recentTimestamp(5),
            "work",
            "five_hour",
            11,
        ]);
        seed.close();

        const upgraded = new UsageLimitsDb(legacyPath);

        try {
            // biome-ignore lint/complexity/useLiteralKeys: bracket access deliberately bypasses the private-field check
            const raw = upgraded["handle"];
            const cols = new Set(
                (raw.prepare("PRAGMA table_info(usage_snapshots)").all() as Array<{ name: string }>).map((c) => c.name)
            );

            expect(cols.has("severity")).toBe(true);
            expect(cols.has("scope_model")).toBe(true);
            expect(upgraded.getSnapshots("work", "five_hour", 60)).toHaveLength(1);
        } finally {
            upgraded.close();
            removeDbFile(legacyPath);
        }
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
        const rawDb = first["handle"];
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

    describe("provider-scoped change detection", () => {
        // The INSERT always writes a provider; a read that matched any provider let a
        // foreign row with the same numbers stand in for the one about to be written.
        test("an anthropic write is not suppressed by an identical openai row", () => {
            db.recordSnapshotV2("work", "five_hour", 42, recentTimestamp(10), {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "openai-sub",
            });

            expect(db.recordIfChanged("work", "five_hour", 42, null)).toBe(true);
            expect(db.getLatest("work", "five_hour", "anthropic-sub")?.utilization).toBe(42);
        });

        // Negative control: a repeat of the SAME provider's row is still deduped.
        test("an unchanged anthropic row is still suppressed", () => {
            expect(db.recordIfChanged("work", "five_hour", 42, null)).toBe(true);
            expect(db.recordIfChanged("work", "five_hour", 42, null)).toBe(false);
        });

        test("a spend write is not suppressed by another provider's identical spend", () => {
            const spend = {
                used_minor: 100,
                used_currency: "USD",
                used_exponent: 2,
                limit_minor: 1000,
                limit_exponent: 2,
                percent: 10,
                severity: "normal",
                enabled: true,
                cap_minor: null,
                cap_currency: null,
            };

            expect(db.recordSpendIfChanged("work", spend, "grok-sub")).toBe(true);
            expect(db.recordSpendIfChanged("work", spend)).toBe(true);
            expect(db.recordSpendIfChanged("work", spend)).toBe(false);
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

            // kind, scopeModel, resets and the point's resetsAt and severity arrived with the
            // series door (design 2026-11-01), availability with step U2: additive, the identity
            // fields are unchanged.
            expect(series).toEqual([
                {
                    provider: "openai-sub",
                    account: "work",
                    key: "primary",
                    kind: null,
                    scopeModel: null,
                    resets: [],
                    availability: [{ from: expect.any(String), to: expect.any(String), state: "limited" }],
                    points: [{ t: expect.any(String), percent: 44, resetsAt: null, severity: null }],
                },
            ]);
        });

        // Two providers CAN carry the same account name and window key. Keyed on the pair
        // alone, their points landed on one line and the chart drew a sawtooth.
        test("an unscoped query keeps two providers' identical keys apart", () => {
            db.recordSnapshot("work", "five_hour", 10, recentTimestamp(30));
            db.recordSnapshotV2("work", "five_hour", 90, recentTimestamp(20), {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "openai-sub",
            });

            const series = db.getSeries({ from: recentTimestamp(60), to: recentTimestamp(0) });

            expect(series).toHaveLength(2);
            expect(series.find((s) => s.provider === "anthropic-sub")?.points.map((p) => p.percent)).toEqual([10]);
            expect(series.find((s) => s.provider === "openai-sub")?.points.map((p) => p.percent)).toEqual([90]);
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
            expect(series[0]).toMatchObject({ provider: "anthropic-sub", account: "work", key: "five_hour" });
        });

        // A caller that names no step used to get every row back: the History tab asks for
        // one series per provider per account per window key, and a 7-day range at the 30s
        // poll period is 20,160 rows each (PR #361 review t1).
        test("no step still bounds a wide range", () => {
            const to = Date.now();
            const from = to - 7 * 24 * 3600_000;

            // Comfortably more samples than the 720-point default keeps, and few enough
            // that the insert loop cannot time out when the suite runs 16 files in parallel.
            const samples = 900;

            for (let i = 0; i < samples; i++) {
                db.recordSnapshot("work", "five_hour", i % 100, new Date(from + i * 300_000).toISOString());
            }

            const bounded = db.getSeries({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
            const every = db.getSeries({
                from: new Date(from).toISOString(),
                to: new Date(to).toISOString(),
                step: 0,
            });

            expect(every[0].points).toHaveLength(samples);
            expect(bounded[0].points.length).toBeLessThanOrEqual(720);
            // The newest sample is what the pace and the top row read, so it must survive.
            expect(bounded[0].points.at(-1)).toEqual(every[0].points.at(-1));
        });

        /**
         * The account checklist can deselect every account, and `toggleAccount` hands that
         * on as `[]`. Treated as "no filter", History drew every account while the filter
         * bar read 0 selected and the Overview showed none (review t13).
         */
        test("an empty account selection is no history, not all history", () => {
            db.recordSnapshot("work", "five_hour", 10, recentTimestamp(30));
            db.recordSnapshot("personal", "five_hour", 20, recentTimestamp(30));

            const from = recentTimestamp(60);
            const to = recentTimestamp(0);

            expect(db.getSeries({ from, to, accounts: [] })).toEqual([]);
            expect(db.getSeries({ from, to, keys: [] })).toEqual([]);
        });

        // Negative control: an OMITTED list still means every account, which is what the
        // unfiltered dashboard and every existing caller rely on.
        test("an omitted account list still returns every account", () => {
            db.recordSnapshot("work", "five_hour", 10, recentTimestamp(30));
            db.recordSnapshot("personal", "five_hour", 20, recentTimestamp(30));

            const series = db.getSeries({ from: recentTimestamp(60), to: recentTimestamp(0) });

            expect(series.map((s) => s.account).sort()).toEqual(["personal", "work"]);
        });

        test("step keeps the last sample of each bucket", () => {
            // Aligned to the step so the two early samples always share one bucket:
            // an unaligned base splits them whenever the wall clock lands near a
            // boundary, which is a flake, not a behaviour change.
            const base = Math.floor(Date.parse(recentTimestamp(60)) / 60_000) * 60_000;
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

    describe("getSeries aggregate modes (in-memory store)", () => {
        const FROM = "2026-11-01T00:00:00.000Z";
        const TO = "2026-11-01T12:00:00.000Z";
        const HOUR = 3_600_000;
        let mem: UsageLimitsDb;

        function put(
            at: string,
            percent: number,
            extras: { resetsAt?: string | null; severity?: string | null; kind?: string | null; key?: string } = {}
        ): void {
            mem.recordSnapshotV2("work", extras.key ?? "five_hour", percent, at, {
                resetsAt: extras.resetsAt === undefined ? "2026-11-01T05:00:00.000Z" : extras.resetsAt,
                severity: extras.severity ?? "ok",
                scopeModel: null,
                provider: "anthropic-sub",
                kind: extras.kind === undefined ? "session" : extras.kind,
            });
        }

        beforeEach(() => {
            mem = new UsageLimitsDb(":memory:");
            // One 5h window: a climb to 90% inside the 04:00 hour, then the 05:00 reset.
            put("2026-11-01T04:05:00.000Z", 40);
            put("2026-11-01T04:30:00.000Z", 90, { severity: "warning" });
            put("2026-11-01T04:50:00.000Z", 85, { severity: "warn" });
            put("2026-11-01T05:01:00.000Z", 2, { resetsAt: "2026-11-01T10:01:00.000Z" });
            put("2026-11-01T05:20:00.000Z", 6, { resetsAt: "2026-11-01T10:01:00.000Z" });
        });

        afterEach(() => {
            mem.close();
        });

        test("raw returns every row and ignores the step", () => {
            const [entry] = mem.getSeries({ from: FROM, to: TO, step: HOUR, agg: "raw" });

            expect(entry.points.map((p) => p.percent)).toEqual([40, 90, 85, 2, 6]);
            // The old vocabulary is normalised on the way out, as on the way in.
            expect(entry.points.map((p) => p.severity)).toEqual(["ok", "warn", "warn", "ok", "ok"]);
        });

        test("last keeps each bucket's last row, so the 90% peak is gone", () => {
            const [entry] = mem.getSeries({ from: FROM, to: TO, step: HOUR, agg: "last" });

            expect(entry.points.map((p) => p.percent)).toEqual([85, 6]);
            expect(entry.points.map((p) => p.t)).toEqual(["2026-11-01T04:50:00.000Z", "2026-11-01T05:20:00.000Z"]);
        });

        test("minmax keeps open, close, min, max and the worst severity per bucket", () => {
            const [entry] = mem.getSeries({ from: FROM, to: TO, step: HOUR, agg: "minmax" });

            expect(entry.bins).toEqual([
                { t: "2026-11-01T04:00:00.000Z", open: 40, close: 85, min: 40, max: 90, severity: "warn" },
                { t: "2026-11-01T05:00:00.000Z", open: 2, close: 6, min: 2, max: 6, severity: "ok" },
            ]);
        });

        test("minmax splits a bucket at a reset, so the peak before it survives a wide step", () => {
            const [entry] = mem.getSeries({ from: FROM, to: TO, step: 6 * HOUR, agg: "minmax" });

            expect(entry.bins).toEqual([
                { t: "2026-11-01T00:00:00.000Z", open: 40, close: 85, min: 40, max: 90, severity: "warn" },
                { t: "2026-11-01T05:01:00.000Z", open: 2, close: 6, min: 2, max: 6, severity: "ok" },
            ]);
        });

        test("every mode reports the reset at the old window's end, whatever the step dropped", () => {
            for (const agg of ["raw", "last", "minmax"] as const) {
                const [entry] = mem.getSeries({ from: FROM, to: TO, step: 6 * HOUR, agg });

                expect(entry.resets).toEqual(["2026-11-01T05:00:00.000Z"]);
            }
        });

        test("poll jitter on resets_at is not a reset", () => {
            put("2026-11-01T05:40:00.000Z", 7, { resetsAt: "2026-11-01T10:01:01.500Z" });

            const [entry] = mem.getSeries({ from: FROM, to: TO, agg: "raw" });

            expect(entry.resets).toEqual(["2026-11-01T05:00:00.000Z"]);
        });

        test("a window whose resets_at vanished after its end reset at that end", () => {
            put("2026-11-01T10:30:00.000Z", 0, { resetsAt: null });

            const [entry] = mem.getSeries({ from: FROM, to: TO, agg: "raw" });

            expect(entry.resets).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T10:01:00.000Z"]);
        });

        test("the kind is part of the identity, and a row without one takes its neighbour's", () => {
            put("2026-11-01T06:00:00.000Z", 30, { key: "primary", kind: null, resetsAt: null });
            put("2026-11-01T07:00:00.000Z", 31, { key: "primary", kind: "session", resetsAt: null });
            put("2026-11-01T08:00:00.000Z", 12, { key: "primary", kind: "weekly", resetsAt: null });

            const primary = mem.getSeries({ from: FROM, to: TO, keys: ["primary"], agg: "raw" });

            expect(primary.map((e) => [e.kind, e.points.map((p) => p.percent)])).toEqual([
                ["session", [30, 31]],
                ["weekly", [12]],
            ]);
            expect(mem.getSeries({ from: FROM, to: TO, kinds: ["weekly"], agg: "raw" }).map((e) => e.key)).toEqual([
                "primary",
            ]);
            expect(mem.getSeries({ from: FROM, to: TO, kinds: [] })).toEqual([]);
        });

        test("minmax bins split on absence and kind re-entry within one bucket", () => {
            const store = new UsageLimitsDb(":memory:");
            const at = (minute: number) => `2026-11-01T04:${String(minute).padStart(2, "0")}:00.000Z`;
            const reading = {
                provider: "openai-sub",
                kind: "session",
                resetsAt: null,
                scopeModel: null,
                severity: null,
            };
            try {
                store.recordSnapshotV2("work", "primary", 10, at(0), reading);
                store.recordSnapshotV2("work", "primary", 0, at(10), { ...reading, availability: "absent" });
                store.recordSnapshotV2("work", "primary", 20, at(20), reading);
                store.recordSnapshotV2("work", "primary", 30, at(30), { ...reading, kind: "weekly" });
                store.recordSnapshotV2("work", "primary", 40, at(40), reading);
                const session = store
                    .getSeries({ from: at(0), to: at(40), step: 3_600_000, agg: "minmax" })
                    .find((entry) => entry.kind === "session");
                expect(session?.bins.map((bin) => [bin.open, bin.close])).toEqual([
                    [10, 10],
                    [20, 20],
                    [40, 40],
                ]);
            } finally {
                store.close();
            }
        });

        test("a slot that changes kind ends one kind's availability where the other starts", () => {
            put("2026-11-01T06:00:00.000Z", 30, { key: "primary", kind: "session", resetsAt: null });
            put("2026-11-01T08:00:00.000Z", 12, { key: "primary", kind: "weekly", resetsAt: null });
            put("2026-11-01T10:00:00.000Z", 5, { key: "primary", kind: "session", resetsAt: null });

            for (const agg of ["raw", "minmax"] as const) {
                const byKind = Object.fromEntries(
                    mem.getSeries({ from: FROM, to: TO, keys: ["primary"], agg }).map((e) => [e.kind, e.availability])
                );

                expect(byKind.session).toEqual([
                    { from: "2026-11-01T06:00:00.000Z", to: "2026-11-01T08:00:00.000Z", state: "limited" },
                    { from: "2026-11-01T10:00:00.000Z", to: TO, state: "limited" },
                ]);
                expect(byKind.weekly).toEqual([
                    { from: "2026-11-01T08:00:00.000Z", to: "2026-11-01T10:00:00.000Z", state: "limited" },
                ]);
            }
        });
    });

    describe("availability", () => {
        const ABSENT = { provider: "anthropic-sub", kind: "session" };

        test("an absent window is one row per change, and the utilization readers skip it", () => {
            db.recordIfChangedV2("work", "five_hour", 40, { resetsAt: null, severity: null, scopeModel: null });

            expect(db.recordAbsentIfChanged("work", "five_hour", ABSENT)).toBe(true);
            expect(db.recordAbsentIfChanged("work", "five_hour", ABSENT)).toBe(false);
            expect(db.getLatest("work", "five_hour")?.utilization).toBe(40);
            expect(db.getSnapshots("work", "five_hour", 60).map((s) => s.utilization)).toEqual([40]);
        });

        test("a window that comes back at its old value is recorded again", () => {
            const extras = { resetsAt: null, severity: null, scopeModel: null };
            db.recordIfChangedV2("work", "five_hour", 40, extras);
            db.recordAbsentIfChanged("work", "five_hour", ABSENT);

            expect(db.recordIfChangedV2("work", "five_hour", 40, extras)).toBe(true);
            expect(db.recordAbsentIfChanged("work", "five_hour", ABSENT)).toBe(true);
        });

        test("the series door turns the rows into spans and keeps absent rows out of the points", () => {
            const at = (minute: number) => `2026-11-01T04:${String(minute).padStart(2, "0")}:00.000Z`;
            const reading = {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "anthropic-sub",
                kind: "session",
            };
            const store = new UsageLimitsDb(":memory:");

            try {
                store.recordSnapshotV2("work", "five_hour", 10, at(0), reading);
                store.recordSnapshotV2("work", "five_hour", 20, at(10), reading);
                store.recordSnapshotV2("work", "five_hour", 0, at(20), { ...reading, availability: "absent" });

                const [entry] = store.getSeries({ from: at(0), to: at(30), agg: "raw" });

                expect(entry.points.map((p) => p.percent)).toEqual([10, 20]);
                expect(entry.availability).toEqual([
                    { from: at(0), to: at(20), state: "limited" },
                    { from: at(20), to: at(30), state: "absent" },
                ]);
            } finally {
                store.close();
            }
        });

        test("the state recorded before the range carries into it: a window gone earlier, and the start of a change", () => {
            const at = (hour: number) => new Date(Date.UTC(2026, 10, 1, hour)).toISOString();
            const reading = {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "anthropic-sub",
                kind: "session",
            };
            const absent = { ...reading, availability: "absent" as const };
            const store = new UsageLimitsDb(":memory:");

            try {
                // "work" lost its window long before the range; "personal" was limited before it and goes in it;
                // "side" is limited and quiet, with no row in the range.
                store.recordSnapshotV2("work", "five_hour", 10, at(0), reading);
                store.recordSnapshotV2("work", "five_hour", 0, at(1), absent);
                store.recordSnapshotV2("personal", "five_hour", 30, at(2), reading);
                store.recordSnapshotV2("personal", "five_hour", 0, at(12), absent);
                store.recordSnapshotV2("side", "five_hour", 50, at(3), reading);

                const series = store.getSeries({ from: at(10), to: at(20), agg: "raw" });
                const byAccount = Object.fromEntries(series.map((entry) => [entry.account, entry]));

                expect(Object.keys(byAccount).sort()).toEqual(["personal", "work"]);
                expect(byAccount.work.points).toEqual([]);
                expect(byAccount.work.availability).toEqual([{ from: at(10), to: at(20), state: "absent" }]);
                expect(byAccount.personal.points).toEqual([]);
                expect(byAccount.personal.availability).toEqual([
                    { from: at(10), to: at(12), state: "limited" },
                    { from: at(12), to: at(20), state: "absent" },
                ]);
                expect(store.getSeries({ from: at(10), to: at(20), agg: "minmax" }).map((e) => e.account)).toEqual([
                    "personal",
                    "work",
                ]);
            } finally {
                store.close();
            }
        });

        test("a reset between the carried row and the first reading in the range is marked; one before it is not", () => {
            const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 1, hour, minute)).toISOString();
            const reading = (resetsAt: string) => ({
                resetsAt,
                severity: null,
                scopeModel: null,
                provider: "anthropic-sub",
                kind: "session",
            });
            const store = new UsageLimitsDb(":memory:");

            try {
                // "work" resets at 10:30, inside the range; "side" reset at 9:30, before it.
                store.recordSnapshotV2("work", "five_hour", 60, at(9), reading(at(10, 30)));
                store.recordSnapshotV2("work", "five_hour", 5, at(11), reading(at(15, 30)));
                store.recordSnapshotV2("side", "five_hour", 60, at(8), reading(at(9, 30)));
                store.recordSnapshotV2("side", "five_hour", 5, at(11), reading(at(14, 30)));

                for (const agg of ["raw", "last", "minmax"] as const) {
                    const series = store.getSeries({ from: at(10), to: at(12), agg });
                    const resets = Object.fromEntries(series.map((entry) => [entry.account, entry.resets]));

                    expect(resets).toEqual({ work: [at(10, 30)], side: [] });
                }
            } finally {
                store.close();
            }
        });

        test("a row from before the column carries unknown into the range until the next recorded state", () => {
            const at = (hour: number) => new Date(Date.UTC(2026, 10, 1, hour)).toISOString();
            const store = new UsageLimitsDb(":memory:");

            try {
                // An older row with no availability (as the column's migration leaves one), then a limited one.
                store.recordSnapshotV2("work", "five_hour", 20, at(2), {
                    resetsAt: null,
                    severity: null,
                    scopeModel: null,
                    provider: "anthropic-sub",
                    kind: "session",
                });
                // biome-ignore lint/complexity/useLiteralKeys: bracket access deliberately bypasses the private-field check
                store["handle"].run("UPDATE usage_snapshots SET availability = NULL");
                store.recordSnapshotV2("work", "five_hour", 30, at(12), {
                    resetsAt: null,
                    severity: null,
                    scopeModel: null,
                    provider: "anthropic-sub",
                    kind: "session",
                    availability: "limited",
                });

                const [entry] = store.getSeries({ from: at(10), to: at(20), agg: "raw" });

                expect(entry.points.map((point) => point.percent)).toEqual([30]);
                expect(entry.availability).toEqual([
                    { from: at(10), to: at(12), state: "unknown" },
                    { from: at(12), to: at(20), state: "limited" },
                ]);
            } finally {
                store.close();
            }
        });

        test("a row from before the column reads as unknown", () => {
            const row = (t: string, availability: "limited" | "absent" | null) => ({
                provider: "anthropic-sub",
                account: "work",
                key: "five_hour",
                kind: "session",
                scopeModel: null,
                t,
                percent: 1,
                resetsAt: null,
                severity: null,
                availability,
            });

            expect(availabilitySpans([row("a", null), row("b", "limited")], "c")).toEqual([
                { from: "a", to: "b", state: "unknown" },
                { from: "b", to: "c", state: "limited" },
            ]);
        });
    });

    describe("openReadOnly", () => {
        const reading = { resetsAt: null, severity: null, scopeModel: null, provider: "openai-sub", kind: "weekly" };

        test("no history file: no view, and no file or folder is created", () => {
            const missing = join(tmpdir(), `ai-usage-limits-missing-${Date.now()}`, "index.db");

            expect(UsageLimitsDb.openReadOnly(missing)).toBeUndefined();
            expect(existsSync(missing)).toBe(false);
            expect(existsSync(join(missing, ".."))).toBe(false);
        });

        test("a store from before the availability column: no view, and its schema is left as it was", () => {
            const oldPath = getTestDbPath();
            const old = new Database(oldPath);
            old.run("CREATE TABLE usage_snapshots (id INTEGER PRIMARY KEY, timestamp TEXT, account_name TEXT)");
            old.close();

            try {
                expect(UsageLimitsDb.openReadOnly(oldPath)).toBeUndefined();

                const check = new Database(oldPath, { readonly: true });
                const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
                const columns = check.prepare("PRAGMA table_info(usage_snapshots)").all();
                check.close();

                expect(tables).toEqual([{ name: "usage_snapshots" }]);
                expect(columns.length).toBe(3);
            } finally {
                removeDbFile(oldPath);
            }
        });

        test("forecast samples read only the provider/account pairs asked for, and none for an empty list", () => {
            db.recordSnapshotV2("work", "secondary", 30, recentTimestamp(10), reading);
            db.recordSnapshotV2("work", "secondary", 31, recentTimestamp(9), { ...reading, provider: "grok-sub" });
            db.recordSnapshotV2("personal", "secondary", 32, recentTimestamp(8), reading);
            const since = new Date(Date.now() - 3_600_000);

            expect(
                db
                    .getForecastSamples({ since, accounts: [{ provider: "openai-sub", account: "work" }] })
                    .map((s) => [s.provider, s.account, s.utilization])
            ).toEqual([["openai-sub", "work", 30]]);
            expect(db.getForecastSamples({ since, accounts: [] })).toEqual([]);
            expect(db.getForecastSamples({ since }).length).toBe(3);
        });

        test("a migrated store reads series and samples through a read-only handle that refuses writes", () => {
            db.recordSnapshotV2("work", "secondary", 30, recentTimestamp(10), reading);
            db.close();

            const view = UsageLimitsDb.openReadOnly(dbPath);

            try {
                expect(view).toBeDefined();
                expect(
                    view
                        ?.getSeries({ from: recentTimestamp(60), to: recentTimestamp(0), agg: "raw" })
                        .map((entry) => [entry.account, entry.points.map((p) => p.percent)])
                ).toEqual([["work", [30]]]);
                expect(view?.getForecastSamples({ since: new Date(Date.now() - 3_600_000) }).length).toBe(1);
                expect(() => view?.recordSnapshotV2("work", "secondary", 40, recentTimestamp(0), reading)).toThrow();
            } finally {
                view?.close();
                db = new UsageLimitsDb(dbPath);
            }
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

describe("limit_drift rows", () => {
    const week = (scopeModel: string | null, tokensPerPct: number): DriftRow => ({
        account: { provider: "anthropic-sub", accountId: "w", accountName: "work" },
        kind: "weekly",
        scopeModel,
        model: "all",
        weeks: [
            {
                week: "2026-10-26",
                windows: 5,
                tokensPerPct,
                usdPerPct: 1,
                ci: [tokensPerPct - 10, tokensPerPct + 10],
                status: "ok",
            },
        ],
        baseline: null,
        verdict: "steady",
    });
    const stored = (handle: Database) =>
        handle.prepare("SELECT scope_model, tokens_per_pct FROM limit_drift ORDER BY scope_model").all() as Array<{
            scope_model: string;
            tokens_per_pct: number;
        }>;

    test("an unscoped and a model-scoped window of one kind keep a row each", () => {
        const store = new UsageLimitsDb(":memory:");

        try {
            const now = new Date("2026-11-02T12:00:00.000Z");
            recordDrift(store.connection(), [week(null, 1000), week("claude-sonnet-4-5", 300)], now);

            expect(stored(store.connection())).toEqual([
                { scope_model: "", tokens_per_pct: 1000 },
                { scope_model: "claude-sonnet-4-5", tokens_per_pct: 300 },
            ]);
        } finally {
            store.close();
        }
    });

    test("a store with the first limit_drift shape keeps its rows as unscoped ones", () => {
        const path = getTestDbPath();
        const seed = new Database(path);
        seed.exec(`
            CREATE TABLE limit_drift (
                provider TEXT NOT NULL, account_id TEXT, account_name TEXT NOT NULL, kind TEXT NOT NULL,
                model TEXT NOT NULL, week TEXT NOT NULL, windows INTEGER NOT NULL, tokens_per_pct REAL,
                usd_per_pct REAL, ci_low REAL, ci_high REAL, status TEXT NOT NULL, computed_at TEXT NOT NULL,
                PRIMARY KEY (provider, account_name, kind, model, week)
            );
            INSERT INTO limit_drift VALUES
                ('anthropic-sub', 'w', 'work', 'weekly', 'all', '2026-10-26', 5, 1000, 1, 990, 1010, 'ok',
                 '2026-11-01T00:00:00.000Z');
        `);
        seed.close();

        const upgraded = new UsageLimitsDb(path);

        try {
            recordDrift(upgraded.connection(), [week("claude-sonnet-4-5", 300)], new Date("2026-11-02T12:00:00.000Z"));

            expect(stored(upgraded.connection())).toEqual([
                { scope_model: "", tokens_per_pct: 1000 },
                { scope_model: "claude-sonnet-4-5", tokens_per_pct: 300 },
            ]);
        } finally {
            upgraded.close();
            removeDbFile(path);
        }
    });
});
