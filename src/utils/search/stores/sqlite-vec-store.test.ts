import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { loadSqliteVec } from "./sqlite-vec-loader";
import { SqliteVecVectorStore } from "./sqlite-vec-store";

describe("sqlite-vec loading", () => {
    it("loads the sqlite-vec extension into bun:sqlite", () => {
        const db = new Database(":memory:");
        const loaded = loadSqliteVec(db);
        expect(loaded).toBe(true);

        const row = db.query("SELECT vec_version() AS version").get() as { version: string };
        expect(row.version).toBeTruthy();
        expect(typeof row.version).toBe("string");

        db.close();
    });

    it("can create a vec0 virtual table", () => {
        const db = new Database(":memory:");
        const loaded = loadSqliteVec(db);
        expect(loaded).toBe(true);

        db.run(`CREATE VIRTUAL TABLE test_vecs USING vec0(
            doc_id TEXT PRIMARY KEY,
            embedding float[3]
        )`);

        db.run("INSERT INTO test_vecs(doc_id, embedding) VALUES (?, ?)", ["a", SafeJSON.stringify([1.0, 0.0, 0.0])]);

        const count = db.query("SELECT COUNT(*) AS cnt FROM test_vecs").get() as { cnt: number };
        expect(count.cnt).toBe(1);

        db.close();
    });
});

describe("SqliteVecVectorStore", () => {
    let db: Database;

    beforeEach(() => {
        db = new Database(":memory:");
        loadSqliteVec(db);
    });

    afterEach(() => {
        db?.close();
    });

    it("stores and searches vectors by cosine similarity", () => {
        const store = new SqliteVecVectorStore(db, { tableName: "test", dimensions: 3 });

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        store.store("c", new Float32Array([0.9, 0.1, 0]));

        const results = store.search(new Float32Array([1, 0, 0]), 3);
        expect(results[0].docId).toBe("a"); // exact match
        expect(results[1].docId).toBe("c"); // close
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it("returns score close to 1 for identical vectors", () => {
        const store = new SqliteVecVectorStore(db, { tableName: "test", dimensions: 3 });
        store.store("a", new Float32Array([1, 0, 0]));

        const results = store.search(new Float32Array([1, 0, 0]), 1);
        // sqlite-vec returns L2 distance, we convert to similarity score.
        // For identical normalized vectors, distance ~ 0, score ~ 1
        expect(results[0].score).toBeGreaterThan(0.95);
    });

    it("removes vectors", () => {
        const store = new SqliteVecVectorStore(db, { tableName: "test", dimensions: 3 });
        store.store("a", new Float32Array([1, 0, 0]));
        store.remove("a");

        const results = store.search(new Float32Array([1, 0, 0]), 10);
        expect(results.length).toBe(0);
    });

    it("returns count of stored vectors", () => {
        const store = new SqliteVecVectorStore(db, { tableName: "test", dimensions: 3 });
        expect(store.count()).toBe(0);

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        expect(store.count()).toBe(2);
    });

    it("replaces vector for existing ID", () => {
        const store = new SqliteVecVectorStore(db, { tableName: "test", dimensions: 3 });
        store.store("a", new Float32Array([1, 0, 0]));
        store.store("a", new Float32Array([0, 1, 0]));

        expect(store.count()).toBe(1);

        const results = store.search(new Float32Array([0, 1, 0]), 1);
        expect(results[0].docId).toBe("a");
        expect(results[0].score).toBeGreaterThan(0.95);
    });
});
