import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathHashStore } from "./path-hashes";

describe("PathHashStore", () => {
    let tmpDir: string;
    let db: Database;

    afterEach(() => {
        db?.close();

        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("stores and retrieves file hashes", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("src/main.ts", "abc123", true);
        store.upsert("src/", "def456", false);

        const hash = store.getHash("src/main.ts");
        expect(hash).toBe("abc123");
    });

    it("updates only changed paths on sync", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("a.ts", "h1", true);
        store.upsert("b.ts", "h2", true);
        store.upsert("c.ts", "h3", true);

        store.upsert("a.ts", "h1-changed", true);

        expect(store.getHash("a.ts")).toBe("h1-changed");
        expect(store.getHash("b.ts")).toBe("h2");
        expect(store.getHash("c.ts")).toBe("h3");
    });

    it("removes deleted paths", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("a.ts", "h1", true);
        store.remove("a.ts");

        expect(store.getHash("a.ts")).toBeNull();
    });

    it("gets all file hashes for Merkle comparison", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("src/a.ts", "h1", true);
        store.upsert("src/b.ts", "h2", true);
        store.upsert("lib/c.ts", "h3", true);

        const all = store.getAllFiles();
        expect(all.size).toBe(3);
        expect(all.get("src/a.ts")).toBe("h1");
    });

    it("excludes directories from getAllFiles()", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("src/a.ts", "h1", true);
        store.upsert("src/", "dir-hash", false);

        const all = store.getAllFiles();
        expect(all.size).toBe(1);
        expect(all.has("src/")).toBe(false);
    });

    it("bulk sync updates/inserts/deletes efficiently", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("a.ts", "h1", true);
        store.upsert("b.ts", "h2", true);

        store.bulkSync([
            { path: "a.ts", hash: "h1-new", isFile: true },
            { path: "c.ts", hash: "h3", isFile: true },
        ]);

        expect(store.getHash("a.ts")).toBe("h1-new");
        expect(store.getHash("b.ts")).toBeNull();
        expect(store.getHash("c.ts")).toBe("h3");
    });

    it("returns null for non-existent paths", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        expect(store.getHash("nonexistent.ts")).toBeNull();
    });

    it("getFileCount returns count without loading all rows", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("100", "h1", true);
        store.upsert("200", "h2", true);
        store.upsert("dir1", "h3", false);

        expect(store.getFileCount()).toBe(2);
    });

    it("getMaxNumericPath returns highest numeric path", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("100", "h1", true);
        store.upsert("50000", "h2", true);
        store.upsert("999", "h3", true);
        store.upsert("not-a-number", "h4", true);

        expect(store.getMaxNumericPath()).toBe(50000);
    });

    it("getMaxNumericPath returns 0 when no numeric paths", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "path-hash-"));
        db = new Database(join(tmpDir, "test.db"));
        const store = new PathHashStore(db);

        store.upsert("src/foo.ts", "h1", true);

        expect(store.getMaxNumericPath()).toBe(0);
    });
});
