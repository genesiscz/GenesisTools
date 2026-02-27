import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeDatabase } from "@app/utils/claude/database";
import { UsageHistoryDb } from "./history-db";

let testCounter = 0;

function getTestDbPath(): string {
    return join(tmpdir(), `claude-usage-test-${Date.now()}-${++testCounter}.sqlite`);
}

function cleanupDb(dbPath: string): void {
    for (const suffix of ["", "-wal", "-shm"]) {
        const file = dbPath + suffix;
        if (existsSync(file)) {
            unlinkSync(file);
        }
    }
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
        cleanupDb(dbPath);
    });

    test("creates database and tables on init", () => {
        expect(existsSync(dbPath)).toBe(true);
    });

    test("records a snapshot", () => {
        db.recordSnapshot("livinka", "five_hour", 42.5, "2026-02-27T14:00:00Z");
        const snapshots = db.getSnapshots("livinka", "five_hour", 60);
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].utilization).toBe(42.5);
    });

    test("recordIfChanged skips duplicate values", () => {
        db.recordSnapshot("livinka", "five_hour", 42.5, "2026-02-27T14:00:00Z");
        const inserted = db.recordIfChanged("livinka", "five_hour", 42.5, null);
        expect(inserted).toBe(false);
        expect(db.getSnapshots("livinka", "five_hour", 60)).toHaveLength(1);
    });

    test("recordIfChanged inserts when value changes", () => {
        db.recordSnapshot("livinka", "five_hour", 42.5, "2026-02-27T14:00:00Z");
        const inserted = db.recordIfChanged("livinka", "five_hour", 43.0, null);
        expect(inserted).toBe(true);
        expect(db.getSnapshots("livinka", "five_hour", 60)).toHaveLength(2);
    });

    test("getSnapshots returns data in time order for graphing", () => {
        db.recordSnapshot("livinka", "five_hour", 10, "2026-02-27T14:00:00Z");
        db.recordSnapshot("livinka", "five_hour", 20, "2026-02-27T14:01:00Z");
        db.recordSnapshot("livinka", "five_hour", 30, "2026-02-27T14:02:00Z");
        const snapshots = db.getSnapshots("livinka", "five_hour", 60);
        expect(snapshots[0].utilization).toBe(10);
        expect(snapshots[2].utilization).toBe(30);
    });

    test("getLatest returns most recent snapshot per bucket", () => {
        db.recordSnapshot("livinka", "five_hour", 10, "2026-02-27T14:00:00Z");
        db.recordSnapshot("livinka", "five_hour", 20, "2026-02-27T14:01:00Z");
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
        db.recordSnapshot("livinka", "five_hour", 10, "2026-02-27T14:00:00Z");
        db.recordSnapshot("livinka", "seven_day", 15, "2026-02-27T14:00:00Z");
        db.recordSnapshot("personal", "five_hour", 5, "2026-02-27T14:00:00Z");

        const pairs = db.getAllAccountBuckets();
        expect(pairs).toHaveLength(3);
    });
});
