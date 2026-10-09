import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStorePackageInstalled } from "@genesiscz/utils/package-store";
import { installStorePackages } from "@genesiscz/utils/packages";
import { optIn } from "@genesiscz/utils/test/skip";
import {
    type LanceDBConnection,
    type LanceDBRow,
    type LanceDBTable,
    LanceDBVectorStore,
    type LanceDBVectorStoreConfig,
} from "./lancedb-vector-store";

type Rows = Map<string, number[]>;

function cosine(left: readonly number[], right: readonly number[]): number {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;

    for (let i = 0; i < left.length; i++) {
        dot += left[i] * right[i];
        leftNorm += left[i] * left[i];
        rightNorm += right[i] * right[i];
    }

    return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

function rowOf(id: string, vector: readonly number[], distance?: number): LanceDBRow {
    return { id, vector: { toArray: () => new Float32Array(vector) }, _distance: distance };
}

/** The slice of a LanceDB table the store uses, over a Map: the same calls, no native module. */
function memoryTable(rows: Rows): LanceDBTable {
    const upsert = async (data: Array<{ id: string; vector: number[] }>) => {
        for (const entry of data) {
            rows.set(entry.id, [...entry.vector]);
        }
    };

    return {
        add: upsert,
        async delete(predicate) {
            const match = /^id = '(.*)'$/.exec(predicate);

            if (match) {
                rows.delete(match[1].replace(/''/g, "'"));
            }
        },
        mergeInsert: () => ({
            whenMatchedUpdateAll: () => ({ whenNotMatchedInsertAll: () => ({ execute: upsert }) }),
        }),
        search: (query) => ({
            distanceType: () => ({
                limit: (n) => ({
                    toArray: async () =>
                        [...rows]
                            .map(([id, vector]) => rowOf(id, vector, 1 - cosine(query, vector)))
                            .sort((a, b) => (a._distance ?? 0) - (b._distance ?? 0))
                            .slice(0, n),
                }),
            }),
        }),
        query: () => ({ toArray: async () => [...rows].map(([id, vector]) => rowOf(id, vector)) }),
        countRows: async () => rows.size,
    };
}

/** An in-memory LanceDB whose databases outlive one store instance, keyed by path like files on disk. */
function memoryLanceDB(): (dbPath: string) => Promise<LanceDBConnection> {
    const disk = new Map<string, Map<string, Rows>>();

    return async (dbPath) => {
        const tables = disk.get(dbPath) ?? new Map<string, Rows>();
        disk.set(dbPath, tables);

        return {
            async createTable(name, data) {
                const rows: Rows = new Map(data.map((entry) => [entry.id, [...entry.vector]]));
                tables.set(name, rows);
                return memoryTable(rows);
            },
            async openTable(name) {
                const rows = tables.get(name);

                if (!rows) {
                    throw new Error(`no table ${name}`);
                }

                return memoryTable(rows);
            },
            tableNames: async () => [...tables.keys()],
        };
    };
}

/**
 * The store's own behaviour (mirror, replace, remove, flush, reload) runs in every test run against the in-memory
 * LanceDB above. The native module is covered separately below, under RUN_INTEGRATION.
 */
function storeSuite(label: string, connect: () => LanceDBVectorStoreConfig["connect"]) {
    describe(label, () => {
        let tmpDir: string;
        let store: LanceDBVectorStore;
        let config: Omit<LanceDBVectorStoreConfig, "dbPath">;

        const open = () => new LanceDBVectorStore({ dbPath: tmpDir, ...config });

        afterEach(async () => {
            if (store) {
                await store.close();
            }

            if (tmpDir) {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        const fresh = () => {
            tmpDir = join(tmpdir(), `lance-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            config = { tableName: "test", dimensions: 3, connect: connect() };
            store = open();
        };

        it("stores and searches vectors by cosine similarity", () => {
            fresh();
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
            fresh();
            store.store("a", new Float32Array([1, 0, 0]));

            const results = store.search(new Float32Array([1, 0, 0]), 1);
            expect(results[0].score).toBeCloseTo(1, 5);
        });

        it("removes vectors", async () => {
            fresh();
            store.store("a", new Float32Array([1, 0, 0]));
            store.remove("a");

            expect(store.search(new Float32Array([1, 0, 0]), 10).length).toBe(0);
            await store.flush();
            expect(await store.searchAsync(new Float32Array([1, 0, 0]), 10)).toEqual([]);
        });

        it("returns count of stored vectors", () => {
            fresh();
            expect(store.count()).toBe(0);

            store.store("a", new Float32Array([1, 0, 0]));
            store.store("b", new Float32Array([0, 1, 0]));
            expect(store.count()).toBe(2);
        });

        it("replaces vector for existing ID", () => {
            fresh();
            store.store("a", new Float32Array([1, 0, 0]));
            store.store("a", new Float32Array([0, 1, 0]));

            expect(store.count()).toBe(1);

            const results = store.search(new Float32Array([0, 1, 0]), 1);
            expect(results[0].docId).toBe("a");
            expect(results[0].score).toBeCloseTo(1, 5);
        });

        it("flushes pending operations to LanceDB", async () => {
            fresh();
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
            fresh();
            store.store("a", new Float32Array([1, 0, 0]));
            store.store("b", new Float32Array([0, 1, 0]));
            await store.close();

            // Reopen, and wait for initialization to load existing data
            store = open();
            await store.flush();

            expect(store.count()).toBe(2);

            const results = store.search(new Float32Array([1, 0, 0]), 2);
            expect(results.length).toBe(2);
            expect(results[0].docId).toBe("a");
        });
    });
}

storeSuite("LanceDBVectorStore", () => memoryLanceDB());

// The native module from the shared package store. Tests run in a sandboxed home whose store is empty, so this
// suite provisions the pinned package itself (network, about a minute cold) and runs only with RUN_INTEGRATION=1.
describe.skipIf(!optIn.integration)("LanceDBVectorStore on native LanceDB", () => {
    beforeAll(async () => {
        if (!isStorePackageInstalled("@lancedb/lancedb")) {
            await installStorePackages(["@lancedb/lancedb"], { silent: true });
        }
    }, 600_000);

    storeSuite("native", () => undefined);
});
