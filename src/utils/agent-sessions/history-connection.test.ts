import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import {
    closeDatabase,
    getCacheMeta,
    getDatabase,
    resetDatabase,
    setCacheMeta,
} from "@genesiscz/utils/claude/history-cache";
import { removeDbFile } from "@genesiscz/utils/fs";
import { tmpdir } from "@genesiscz/utils/paths";
import { HistoryDatabase } from "./database";

const cacheDir = mkdtempSync(join(tmpdir(), "history-connection-"));
const dbPath = join(cacheDir, "index.db");

afterEach(() => {
    closeDatabase();
    ClaudeDatabase.closeInstance();
    removeDbFile(dbPath);
});

// Regression test: CompactProviderHistoryRefactor section15 — both facades must share transaction visibility.
test("legacy history reads the connection owner's uncommitted metadata", () => {
    getDatabase(cacheDir);
    const connection = ClaudeDatabase.getInstance(dbPath).getDb();
    connection.run("BEGIN");

    try {
        connection.query("INSERT INTO cache_meta (key, value) VALUES (?, ?)").run("history:probe", "visible");
        expect(getCacheMeta("history:probe")).toBe("visible");
    } finally {
        connection.run("ROLLBACK");
    }
});

// Regression test: CompactProviderHistoryRefactor section15 — a consumer must not close a sibling's shared handle.
test("closing one default usage facade leaves other readers usable", () => {
    ClaudeDatabase.getInstance(dbPath);
    const first = new UsageLimitsDb();
    const second = new UsageLimitsDb();
    first.recordSnapshot("work", "five_hour", 42, "2026-08-15T12:00:00.000Z");
    first.close();

    expect(second.getLatest("work", "five_hour")?.utilization).toBe(42);
});

// Regression test: CompactProviderHistoryRefactor section20 — resetting derived history must preserve observations.
test("history reset clears the selected cache while retaining usage measurements", () => {
    getDatabase(cacheDir);
    const usage = new UsageLimitsDb();
    usage.recordSnapshot("work", "five_hour", 42, "2026-08-15T12:00:00.000Z");
    setCacheMeta("metadata_version", "fixture-parser");
    resetDatabase();
    getDatabase(cacheDir);
    const reopenedUsage = new UsageLimitsDb();

    expect(getCacheMeta("metadata_version")).toBeNull();
    expect(reopenedUsage.getLatest("work", "five_hour")?.utilization).toBe(42);
});

test("a borrower cannot close the shared history connection out from under the others", () => {
    const borrower = HistoryDatabase.getInstance(":memory:");
    const other = HistoryDatabase.getInstance(":memory:");
    expect(other).toBe(borrower);

    borrower.close();

    // Still usable for everyone else; only closeInstance() ends it.
    expect(other.getDb().query<{ value: number }, []>("SELECT 1 AS value").get()?.value).toBe(1);
    HistoryDatabase.closeInstance();
    expect(() => other.getDb().query("SELECT 1").get()).toThrow();
});
