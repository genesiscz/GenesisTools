import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { ensureExtensionCapableSQLite } from "@app/utils/search/stores/sqlite-vec-loader";
import { _resetIndexerStorageForTesting, wipeAllTestIndexes } from "./storage";
import { createIndexStore } from "./store";

ensureExtensionCapableSQLite();

const ORIG_HOME = env.get("HOME");
let tmpHome: string;

beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "vacuum-test-"));
    env.testing.set("HOME", tmpHome);
    _resetIndexerStorageForTesting();
});

afterAll(() => {
    if (ORIG_HOME !== undefined) {
        env.testing.set("HOME", ORIG_HOME);
    } else {
        env.testing.unset("HOME");
    }

    _resetIndexerStorageForTesting();
    wipeAllTestIndexes();
    rmSync(tmpHome, { recursive: true, force: true });
});

describe("store.removeOrphanVectors", () => {
    it("deletes legacy _embeddings rows whose doc_id has no _content row", async () => {
        const indexName = `gt_indexer_test_vacuum_${Date.now()}`;
        const store = await createIndexStore({ name: indexName, baseDir: "" });

        // Seed two content chunks.
        await store.insertChunks([
            {
                id: "a",
                content: "alpha",
                name: "n1",
                filePath: "p1",
                sourceId: "1",
                startLine: 0,
                endLine: 0,
                kind: "x",
            },
            {
                id: "b",
                content: "beta",
                name: "n2",
                filePath: "p2",
                sourceId: "2",
                startLine: 0,
                endLine: 0,
                kind: "x",
            },
        ]);

        // Manually create + populate the legacy `_embeddings` table with rows for
        // both live IDs and an orphan that has no content row. This mimics what
        // older versions of pruneStale left behind.
        const db = store.getDb();
        const tableName = indexName.replace(/[^a-zA-Z0-9_]/g, "_");
        db.run(`CREATE TABLE IF NOT EXISTS ${tableName}_embeddings (doc_id TEXT PRIMARY KEY, embedding BLOB NOT NULL)`);
        const blob = Buffer.alloc(4);
        db.run(`INSERT INTO ${tableName}_embeddings (doc_id, embedding) VALUES (?, ?)`, ["a", blob]);
        db.run(`INSERT INTO ${tableName}_embeddings (doc_id, embedding) VALUES (?, ?)`, ["b", blob]);
        db.run(`INSERT INTO ${tableName}_embeddings (doc_id, embedding) VALUES (?, ?)`, ["orphan-z", blob]);

        // Simulate the historical leak: drop a content row directly without using removeChunks.
        db.run(`DELETE FROM ${tableName}_content WHERE id = ?`, ["a"]);

        const result = await store.removeOrphanVectors();
        expect(result.removed).toBe(2);

        const remaining = db.query(`SELECT doc_id FROM ${tableName}_embeddings ORDER BY doc_id`).all() as Array<{
            doc_id: string;
        }>;
        expect(remaining).toEqual([{ doc_id: "b" }]);

        await store.close();
    });

    it("returns {removed: 0} when there are no orphans", async () => {
        const indexName = `gt_indexer_test_vacuum_clean_${Date.now()}`;
        const store = await createIndexStore({ name: indexName, baseDir: "" });

        await store.insertChunks([
            { id: "a", content: "x", name: "n", filePath: "p", sourceId: "1", startLine: 0, endLine: 0, kind: "x" },
        ]);

        const result = await store.removeOrphanVectors();
        expect(result.removed).toBe(0);

        await store.close();
    });
});
