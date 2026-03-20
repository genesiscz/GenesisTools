import { describe, expect, it, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVectorStore } from "./sqlite-vector-store";

describe("SqliteVectorStore", () => {
    let tmpDir: string;
    let db: Database;

    afterEach(() => {
        db?.close();

        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("stores and searches vectors by cosine similarity", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "vec-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");

        const store = new SqliteVectorStore(db, { tableName: "test", dimensions: 3 });

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        store.store("c", new Float32Array([0.9, 0.1, 0]));

        const results = store.search(new Float32Array([1, 0, 0]), 3);
        expect(results[0].docId).toBe("a"); // exact match
        expect(results[1].docId).toBe("c"); // close
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it("returns score = 1 for identical vectors", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "vec-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");

        const store = new SqliteVectorStore(db, { tableName: "test", dimensions: 3 });

        store.store("a", new Float32Array([1, 0, 0]));

        const results = store.search(new Float32Array([1, 0, 0]), 1);
        expect(results[0].score).toBeCloseTo(1, 5);
    });

    it("removes vectors", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "vec-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");

        const store = new SqliteVectorStore(db, { tableName: "test", dimensions: 3 });
        store.store("a", new Float32Array([1, 0, 0]));
        store.remove("a");

        const results = store.search(new Float32Array([1, 0, 0]), 10);
        expect(results.length).toBe(0);
    });

    it("returns count of stored vectors", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "vec-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");

        const store = new SqliteVectorStore(db, { tableName: "test", dimensions: 3 });
        expect(store.count()).toBe(0);

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        expect(store.count()).toBe(2);
    });

    it("replaces vector for existing ID", () => {
        tmpDir = mkdtempSync(join(tmpdir(), "vec-store-"));
        db = new Database(join(tmpDir, "test.db"));
        db.run("PRAGMA journal_mode = WAL");

        const store = new SqliteVectorStore(db, { tableName: "test", dimensions: 3 });
        store.store("a", new Float32Array([1, 0, 0]));
        store.store("a", new Float32Array([0, 1, 0]));

        expect(store.count()).toBe(1);

        const results = store.search(new Float32Array([0, 1, 0]), 1);
        expect(results[0].docId).toBe("a");
        expect(results[0].score).toBeCloseTo(1, 5);
    });
});
