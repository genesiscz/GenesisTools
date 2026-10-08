import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDatabaseReadSnapshots, withDatabaseReadSnapshot } from "./read-snapshot";

function store(rows: number): string {
    const path = join(mkdtempSync(join(tmpdir(), "read-snapshot-test-")), "store.db");
    const db = new Database(path);
    db.run("CREATE TABLE item (id INTEGER PRIMARY KEY, body TEXT)");
    const insert = db.prepare("INSERT INTO item (body) VALUES (?)");
    for (let index = 0; index < rows; index++) {
        insert.run("x".repeat(1000));
    }

    db.close();
    return path;
}

function copies(): string[] {
    return readdirSync(tmpdir()).filter((name) => /^read-snapshot-[0-9a-f-]{36}\.sqlite/.test(name));
}

describe("withDatabaseReadSnapshot", () => {
    it("copies a store past the memory limit through a temporary file, never into memory, and removes it", () => {
        const path = store(200);
        const before = copies().length;
        const count = withDatabaseReadSnapshot({
            path,
            maxMemoryBytes: 16 * 1024,
            initialize: (db) => db.run("CREATE TABLE IF NOT EXISTS derived (id INTEGER)"),
            read: (db) => {
                expect(db.filename).toContain("read-snapshot-");
                return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item").get()?.n;
            },
        });

        expect(count).toBe(200);
        expect(copies().length).toBe(before);
        // The schema change went to the copy, not the store.
        const source = new Database(path, { readonly: true });
        expect(source.query("SELECT name FROM sqlite_master WHERE name = 'derived'").get()).toBeNull();
        source.close();
    });

    it("keeps a small store in memory", () => {
        const path = store(3);
        const name = withDatabaseReadSnapshot({ path, initialize: () => undefined, read: (db) => db.filename });
        expect(name).not.toContain("read-snapshot-");
        clearDatabaseReadSnapshots();
    });
});
