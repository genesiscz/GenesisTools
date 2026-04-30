import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExtensionCapableSQLite } from "@app/utils/search/stores/sqlite-vec-loader";
import type { IndexerSource, MetadataPopulateOpts, MetadataResult } from "./sources/source";
import { _resetIndexerStorageForTesting, wipeAllTestIndexes } from "./storage";
import { createIndexStore, searchIndexReadonly } from "./store";

ensureExtensionCapableSQLite();

/**
 * Phase 2 end-to-end verification with a mock source.
 *
 * Asserts the foundation is wired correctly:
 *   - source.metadataColumns() drives ALTER TABLE + index creation
 *   - source.populateMetadata generator backfills existing rows on column add
 *   - insertChunks writes typed columns + JSON bag per chunk
 *   - searchIndexReadonly merges typed cols + bag into result.doc.metadata
 *   - metadataFilters predicate narrows results correctly (BETWEEN / =)
 *
 * Mail does NOT adopt this; tests use a synthetic mock source to keep the
 * library decoupled from any concrete source.
 */

const ORIG_HOME = process.env.HOME;
let tmpHome: string;

beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "phase2-e2e-"));
    process.env.HOME = tmpHome;
    _resetIndexerStorageForTesting();
});

afterAll(() => {
    if (ORIG_HOME !== undefined) {
        process.env.HOME = ORIG_HOME;
    } else {
        delete process.env.HOME;
    }

    _resetIndexerStorageForTesting();

    // Belt-and-suspenders: if HOME redirect lost the singleton race the dirs
    // landed in the real homedir. wipeAllTestIndexes covers them.
    wipeAllTestIndexes();

    rmSync(tmpHome, { recursive: true, force: true });
});

async function* yieldBatches(
    sourceIds: string[],
    batchSize: number,
    valueFor: (id: string) => Record<string, unknown>
): AsyncGenerator<MetadataResult[]> {
    let i = 0;
    while (i < sourceIds.length) {
        const slice = sourceIds.slice(i, i + batchSize);
        yield slice.map((sid) => ({ sourceId: sid, metadata: valueFor(sid) }));
        i += batchSize;
    }
}

describe("Phase 2 metadata pushdown (mock source, library-only)", () => {
    it("inserts typed cols + JSON bag, retrieves both via search", async () => {
        const source: IndexerSource = {
            scan: async () => [],
            detectChanges: () => ({ added: [], modified: [], deleted: [], unchanged: [] }),
            hashEntry: () => "h",
            metadataColumns: () => [
                { name: "dateSent", type: "INTEGER", indexed: true },
                { name: "category", type: "TEXT" },
            ],
            populateMetadata: ({ entries, batchSize }: MetadataPopulateOpts) =>
                yieldBatches(
                    entries.map((e) => e.sourceId),
                    batchSize ?? 1000,
                    () => ({})
                ),
        };

        const store = await createIndexStore({ name: "phase2-merge", baseDir: "", source });
        await store.insertChunks([
            {
                id: "c1",
                content: "hello world",
                name: "n",
                filePath: "p",
                sourceId: "s1",
                startLine: 0,
                endLine: 0,
                kind: "x",
                metadata: { dateSent: 100, category: "blog", flagged: true, threadId: "T1" },
            },
        ]);
        await store.close?.();

        const results = await searchIndexReadonly("phase2-merge", "hello", {
            mode: "fulltext",
            limit: 10,
        });
        expect(results).toHaveLength(1);

        const md = results[0].doc.metadata as Record<string, unknown>;
        expect(md).toBeDefined();
        expect(md.dateSent).toBe(100);
        expect(md.category).toBe("blog");
        expect(md.flagged).toBe(true);
        expect(md.threadId).toBe("T1");
    });

    it("metadataFilters narrows results by typed column (= and BETWEEN)", async () => {
        const source: IndexerSource = {
            scan: async () => [],
            detectChanges: () => ({ added: [], modified: [], deleted: [], unchanged: [] }),
            hashEntry: () => "h",
            metadataColumns: () => [
                { name: "dateSent", type: "INTEGER", indexed: true },
                { name: "category", type: "TEXT" },
            ],
            populateMetadata: ({ entries, batchSize }: MetadataPopulateOpts) =>
                yieldBatches(
                    entries.map((e) => e.sourceId),
                    batchSize ?? 1000,
                    () => ({})
                ),
        };

        const store = await createIndexStore({ name: "phase2-filter", baseDir: "", source });

        const chunks = Array.from({ length: 100 }, (_, i) => ({
            id: `c${i}`,
            content: `doc ${i} contains alpha`,
            name: `n${i}`,
            filePath: `p${i}`,
            sourceId: `s${i}`,
            startLine: 0,
            endLine: 0,
            kind: "x",
            metadata: { dateSent: i * 100, category: i % 2 === 0 ? "blog" : "news" },
        }));
        await store.insertChunks(chunks);
        await store.close?.();

        const between = await searchIndexReadonly("phase2-filter", "alpha", {
            mode: "fulltext",
            limit: 1000,
            metadataFilters: [{ column: "dateSent", op: "BETWEEN", value: [2000, 5000] }],
        });
        expect(between.length).toBe(31); // i=20..50 inclusive
        for (const r of between) {
            const md = r.doc.metadata as Record<string, unknown>;
            const d = md.dateSent as number;
            expect(d).toBeGreaterThanOrEqual(2000);
            expect(d).toBeLessThanOrEqual(5000);
        }

        const equality = await searchIndexReadonly("phase2-filter", "alpha", {
            mode: "fulltext",
            limit: 1000,
            metadataFilters: [{ column: "category", op: "=", value: "blog" }],
        });
        expect(equality.length).toBe(50);
        for (const r of equality) {
            const md = r.doc.metadata as Record<string, unknown>;
            expect(md.category).toBe("blog");
        }
    });

    it("backfills new column for existing rows (v1 → v2 schema bump)", async () => {
        const v1: IndexerSource = {
            scan: async () => [],
            detectChanges: () => ({ added: [], modified: [], deleted: [], unchanged: [] }),
            hashEntry: () => "h",
            metadataColumns: () => [{ name: "category", type: "TEXT" }],
            populateMetadata: ({ entries, batchSize }: MetadataPopulateOpts) =>
                yieldBatches(
                    entries.map((e) => e.sourceId),
                    batchSize ?? 1000,
                    () => ({})
                ),
        };

        const indexName = `phase2-bf-${Date.now()}`;
        const store1 = await createIndexStore({ name: indexName, baseDir: "", source: v1 });
        await store1.insertChunks([
            {
                id: "c1",
                content: "alpha",
                name: "n",
                filePath: "p",
                sourceId: "s1",
                startLine: 0,
                endLine: 0,
                kind: "x",
                metadata: { category: "blog" },
            },
            {
                id: "c2",
                content: "alpha",
                name: "n",
                filePath: "p",
                sourceId: "s2",
                startLine: 0,
                endLine: 0,
                kind: "x",
                metadata: { category: "news" },
            },
        ]);
        await store1.close?.();

        const v2: IndexerSource = {
            ...v1,
            metadataColumns: () => [
                { name: "category", type: "TEXT" },
                { name: "score", type: "REAL", indexed: true },
            ],
            populateMetadata: ({ entries, batchSize }: MetadataPopulateOpts) => {
                const map = new Map<string, Record<string, unknown>>([
                    ["s1", { score: 0.9 }],
                    ["s2", { score: 0.5 }],
                ]);
                return yieldBatches(
                    entries.map((e) => e.sourceId),
                    batchSize ?? 1000,
                    (id) => map.get(id) ?? {}
                );
            },
        };

        const store2 = await createIndexStore({ name: indexName, baseDir: "", source: v2 });
        await store2.close?.();

        const results = await searchIndexReadonly(indexName, "alpha", {
            mode: "fulltext",
            limit: 10,
            metadataFilters: [{ column: "score", op: ">=", value: 0.7 }],
        });
        expect(results).toHaveLength(1);
        const md = results[0].doc.metadata as Record<string, unknown>;
        expect(md.score).toBe(0.9);
        expect(md.category).toBe("blog");
    });

    it("does NOT touch indexes whose source has no metadataColumns()", async () => {
        const bareSource: IndexerSource = {
            scan: async () => [],
            detectChanges: () => ({ added: [], modified: [], deleted: [], unchanged: [] }),
            hashEntry: () => "h",
        };

        const store = await createIndexStore({ name: "phase2-bare", baseDir: "", source: bareSource });
        await store.insertChunks([
            {
                id: "c1",
                content: "alpha",
                name: "n",
                filePath: "p",
                sourceId: "s1",
                startLine: 0,
                endLine: 0,
                kind: "x",
            },
        ]);
        await store.close?.();

        const results = await searchIndexReadonly("phase2-bare", "alpha", {
            mode: "fulltext",
            limit: 10,
        });
        expect(results).toHaveLength(1);
        // No typed cols declared → metadata is the JSON bag only (empty).
        const md = (results[0].doc.metadata ?? {}) as Record<string, unknown>;
        expect(Object.keys(md)).toEqual([]);
    });
});
