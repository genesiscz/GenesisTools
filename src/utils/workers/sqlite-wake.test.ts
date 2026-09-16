import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDataVersion, watchSqliteChanges } from "./sqlite-wake";

describe("watchSqliteChanges", () => {
    it("is a no-op for an in-memory database", () => {
        const db = new Database(":memory:");
        const stop = watchSqliteChanges(db, () => {
            throw new Error("must not fire");
        });
        stop();
        db.close();
    });

    it("fires for another connection's commit and stays quiet for its own", async () => {
        const dir = mkdtempSync(join(tmpdir(), "sqlite-wake-"));
        const path = join(dir, "q.db");
        const mine = new Database(path);
        mine.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        let fired = 0;
        const stop = watchSqliteChanges(mine, () => {
            fired++;
        });

        try {
            mine.run("INSERT INTO t (v) VALUES ('mine')");
            await Bun.sleep(80);
            expect(fired).toBe(0);

            const other = new Database(path);
            other.run("INSERT INTO t (v) VALUES ('theirs')");
            other.close();
            const startedAt = Date.now();

            while (fired === 0 && Date.now() - startedAt < 1500) {
                await Bun.sleep(5);
            }

            expect(fired).toBe(1);
        } finally {
            stop();
            mine.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("readDataVersion returns a number", () => {
        const db = new Database(":memory:");
        expect(typeof readDataVersion(db)).toBe("number");
        db.close();
    });

    it("readDataVersion stays a number when the database uses safeIntegers", () => {
        const db = new Database(":memory:", { safeIntegers: true });
        const version = readDataVersion(db);
        expect(typeof version).toBe("number");
        expect(Number.isFinite(version)).toBe(true);
        db.close();
    });
});
