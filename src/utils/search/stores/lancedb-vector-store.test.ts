import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStorePackageInstalled } from "@genesiscz/utils/package-store";
import { LanceDBVectorStore } from "./lancedb-vector-store";

// LanceDB lives in the shared package store, and tests run against a sandboxed home with an
// empty store, so this suite skips by default. Run it against the real store with
// `GENESIS_TOOLS_HOME=$HOME bun run test src/utils/search/stores/lancedb-vector-store.test.ts`.
describe.skipIf(!isStorePackageInstalled("@lancedb/lancedb"))("LanceDBVectorStore", () => {
    let tmpDir: string;
    let store: LanceDBVectorStore;

    afterEach(async () => {
        if (store) {
            await store.close();
        }

        if (tmpDir) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("stores and searches vectors by cosine similarity", async () => {
        tmpDir = join(tmpdir(), `lance-store-${Date.now()}`);
        store = new LanceDBVectorStore({ dbPath: tmpDir, tableName: "test", dimensions: 3 });

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        store.store("c", new Float32Array([0.9, 0.1, 0]));

        // Synchronous search uses in-memory mirror
        const results = store.search(new Float32Array([1, 0, 0]), 3);
        expect(results[0].docId).toBe("a");
        expect(results[1].docId).toBe("c");
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it("returns score close to 1 for identical vectors", () => {
        tmpDir = join(tmpdir(), `lance-store-${Date.now()}`);
        store = new LanceDBVectorStore({ dbPath: tmpDir, tableName: "test", dimensions: 3 });

        store.store("a", new Float32Array([1, 0, 0]));

        const results = store.search(new Float32Array([1, 0, 0]), 1);
        expect(results[0].score).toBeCloseTo(1, 5);
    });

    it("removes vectors", () => {
        tmpDir = join(tmpdir(), `lance-store-${Date.now()}`);
        store = new LanceDBVectorStore({ dbPath: tmpDir, tableName: "test", dimensions: 3 });

        store.store("a", new Float32Array([1, 0, 0]));
        store.remove("a");

        const results = store.search(new Float32Array([1, 0, 0]), 10);
        expect(results.length).toBe(0);
    });

    it("returns count of stored vectors", () => {
        tmpDir = join(tmpdir(), `lance-store-${Date.now()}`);
        store = new LanceDBVectorStore({ dbPath: tmpDir, tableName: "test", dimensions: 3 });

        expect(store.count()).toBe(0);

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        expect(store.count()).toBe(2);
    });

    it("replaces vector for existing ID", () => {
        tmpDir = join(tmpdir(), `lance-store-${Date.now()}`);
        store = new LanceDBVectorStore({ dbPath: tmpDir, tableName: "test", dimensions: 3 });

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("a", new Float32Array([0, 1, 0]));

        expect(store.count()).toBe(1);

        const results = store.search(new Float32Array([0, 1, 0]), 1);
        expect(results[0].docId).toBe("a");
        expect(results[0].score).toBeCloseTo(1, 5);
    });

    it("flushes pending operations to LanceDB", async () => {
        tmpDir = join(tmpdir(), `lance-store-${Date.now()}`);
        store = new LanceDBVectorStore({ dbPath: tmpDir, tableName: "test", dimensions: 3 });

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));

        await store.flush();

        // After flush, async search should return results from LanceDB
        const results = await store.searchAsync(new Float32Array([1, 0, 0]), 2);
        expect(results.length).toBe(2);
        expect(results[0].docId).toBe("a");
        expect(results[0].score).toBeCloseTo(1, 2);
    });

    it("persists data across instances", async () => {
        tmpDir = join(tmpdir(), `lance-store-${Date.now()}`);

        store = new LanceDBVectorStore({ dbPath: tmpDir, tableName: "test", dimensions: 3 });
        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        await store.close();

        // Reopen
        store = new LanceDBVectorStore({ dbPath: tmpDir, tableName: "test", dimensions: 3 });

        // Wait for initialization to load existing data
        await store.flush();

        expect(store.count()).toBe(2);

        const results = store.search(new Float32Array([1, 0, 0]), 2);
        expect(results.length).toBe(2);
        expect(results[0].docId).toBe("a");
    });
});
