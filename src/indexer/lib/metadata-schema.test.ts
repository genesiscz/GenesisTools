import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { applySourceMetadataSchema, backfillMetadataColumns } from "./metadata-schema";
import type { IndexerSource, MetadataPopulateOpts, MetadataResult } from "./sources/source";
import type { MetadataColumnSpec } from "./types";

function freshContent(db: Database): void {
    db.run("CREATE TABLE t_content (id TEXT PRIMARY KEY, source_id TEXT, metadata_json TEXT DEFAULT '{}')");
}

describe("applySourceMetadataSchema", () => {
    it("adds typed columns and creates indexes for indexed: true", () => {
        const db = new Database(":memory:");
        freshContent(db);
        const cols: MetadataColumnSpec[] = [
            { name: "dateSent", type: "INTEGER", indexed: true },
            { name: "category", type: "TEXT" },
        ];

        const r = applySourceMetadataSchema(db, "t", cols, []);
        expect(r.added).toEqual(["dateSent", "category"]);
        expect(r.indexed).toEqual(["dateSent"]);

        const tableCols = (db.query("PRAGMA table_info(t_content)").all() as Array<{ name: string }>).map(
            (c) => c.name
        );
        expect(tableCols).toContain("dateSent");
        expect(tableCols).toContain("category");

        const idxes = (
            db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='t_content'").all() as Array<{
                name: string;
            }>
        ).map((i) => i.name);
        expect(idxes).toContain("idx_t_content_dateSent");
        expect(idxes).not.toContain("idx_t_content_category");
        db.close();
    });

    it("is a no-op when declared == persisted", () => {
        const db = new Database(":memory:");
        freshContent(db);
        db.run("ALTER TABLE t_content ADD COLUMN dateSent INTEGER");
        db.run("CREATE INDEX idx_t_content_dateSent ON t_content(dateSent)");

        const cols: MetadataColumnSpec[] = [{ name: "dateSent", type: "INTEGER", indexed: true }];
        const r = applySourceMetadataSchema(db, "t", cols, cols);
        expect(r.added).toEqual([]);
        expect(r.indexed).toEqual([]);
        db.close();
    });

    it("rejects type changes via the same column name", () => {
        const db = new Database(":memory:");
        freshContent(db);
        db.run("ALTER TABLE t_content ADD COLUMN score TEXT");

        const declared: MetadataColumnSpec[] = [{ name: "score", type: "REAL" }];
        const persisted: MetadataColumnSpec[] = [{ name: "score", type: "TEXT" }];
        expect(() => applySourceMetadataSchema(db, "t", declared, persisted)).toThrow(/type/i);
        db.close();
    });

    it("ignores removed columns (does not DROP)", () => {
        const db = new Database(":memory:");
        freshContent(db);
        db.run("ALTER TABLE t_content ADD COLUMN score REAL");

        const r = applySourceMetadataSchema(db, "t", [], [{ name: "score", type: "REAL" }]);
        expect(r.added).toEqual([]);

        const cols = (db.query("PRAGMA table_info(t_content)").all() as Array<{ name: string }>).map((c) => c.name);
        expect(cols).toContain("score");
        db.close();
    });

    it("rejects invalid column names", () => {
        const db = new Database(":memory:");
        freshContent(db);
        expect(() => applySourceMetadataSchema(db, "t", [{ name: "no spaces", type: "TEXT" }], [])).toThrow(
            /invalid column/i
        );
        expect(() => applySourceMetadataSchema(db, "t", [{ name: "1bad", type: "TEXT" }], [])).toThrow(
            /invalid column/i
        );
        db.close();
    });

    it("appends incremental columns without re-adding existing ones", () => {
        const db = new Database(":memory:");
        freshContent(db);
        applySourceMetadataSchema(db, "t", [{ name: "category", type: "TEXT", indexed: true }], []);

        const r = applySourceMetadataSchema(
            db,
            "t",
            [
                { name: "category", type: "TEXT", indexed: true },
                { name: "score", type: "REAL", indexed: false },
            ],
            [{ name: "category", type: "TEXT", indexed: true }]
        );
        expect(r.added).toEqual(["score"]);
        expect(r.indexed).toEqual([]);
        db.close();
    });
});

async function* generatorFor(
    values: Map<string, Record<string, unknown>>,
    batchSize: number,
    sourceIds: string[]
): AsyncGenerator<MetadataResult[]> {
    let i = 0;
    while (i < sourceIds.length) {
        const slice = sourceIds.slice(i, i + batchSize);
        yield slice.map((sid) => ({ sourceId: sid, metadata: values.get(sid) ?? {} }));
        i += batchSize;
    }
}

describe("backfillMetadataColumns", () => {
    it("populates new columns for existing rows via the generator API", async () => {
        const db = new Database(":memory:");
        freshContent(db);
        db.run("ALTER TABLE t_content ADD COLUMN dateSent INTEGER");
        db.run("INSERT INTO t_content (id, source_id) VALUES ('c1', 's1'), ('c2', 's2'), ('c3', 's3')");

        const values = new Map([
            ["s1", { dateSent: 100 }],
            ["s2", { dateSent: 200 }],
            ["s3", { dateSent: 300 }],
        ]);

        const source: IndexerSource = {
            scan: async () => [],
            detectChanges: () => ({ added: [], modified: [], deleted: [], unchanged: [] }),
            hashEntry: () => "h",
            metadataColumns: () => [{ name: "dateSent", type: "INTEGER", indexed: true }],
            populateMetadata: (opts: MetadataPopulateOpts) =>
                generatorFor(
                    values,
                    opts.batchSize ?? 1000,
                    opts.entries.map((e) => e.sourceId)
                ),
        };

        const cols: MetadataColumnSpec[] = [{ name: "dateSent", type: "INTEGER", indexed: true }];
        await backfillMetadataColumns(db, "t", source, cols);

        const rows = db.query("SELECT source_id, dateSent FROM t_content ORDER BY source_id").all() as Array<{
            source_id: string;
            dateSent: number;
        }>;
        expect(rows).toEqual([
            { source_id: "s1", dateSent: 100 },
            { source_id: "s2", dateSent: 200 },
            { source_id: "s3", dateSent: 300 },
        ]);
        db.close();
    });

    it("respects source-controlled batch boundaries (generator yields)", async () => {
        const db = new Database(":memory:");
        freshContent(db);
        db.run("ALTER TABLE t_content ADD COLUMN n INTEGER");

        const tx = db.transaction(() => {
            for (let i = 0; i < 2500; i++) {
                db.run("INSERT INTO t_content (id, source_id) VALUES (?, ?)", [`c${i}`, `s${i}`]);
            }
        });
        tx();

        const yields: number[] = [];
        const source: IndexerSource = {
            scan: async () => [],
            detectChanges: () => ({ added: [], modified: [], deleted: [], unchanged: [] }),
            hashEntry: () => "h",
            metadataColumns: () => [{ name: "n", type: "INTEGER" }],
            async *populateMetadata(opts) {
                const ids = opts.entries.map((e) => e.sourceId);
                for (let i = 0; i < ids.length; i += 1000) {
                    const batch = ids.slice(i, i + 1000);
                    yields.push(batch.length);
                    yield batch.map((sid) => ({ sourceId: sid, metadata: { n: Number(sid.slice(1)) } }));
                }
            },
        };

        await backfillMetadataColumns(db, "t", source, [{ name: "n", type: "INTEGER" }]);
        expect(yields).toEqual([1000, 1000, 500]);

        const total = (db.query("SELECT COUNT(*) AS c FROM t_content WHERE n IS NOT NULL").get() as { c: number }).c;
        expect(total).toBe(2500);
        db.close();
    });

    it("is a no-op when source has no populateMetadata", async () => {
        const db = new Database(":memory:");
        freshContent(db);
        db.run("ALTER TABLE t_content ADD COLUMN x INTEGER");
        db.run("INSERT INTO t_content (id, source_id) VALUES ('c1', 's1')");

        const source: IndexerSource = {
            scan: async () => [],
            detectChanges: () => ({ added: [], modified: [], deleted: [], unchanged: [] }),
            hashEntry: () => "h",
        };

        const touched = await backfillMetadataColumns(db, "t", source, [{ name: "x", type: "INTEGER" }]);
        expect(touched).toBe(0);
        const x = (db.query("SELECT x FROM t_content").get() as { x: number | null }).x;
        expect(x).toBeNull();
        db.close();
    });

    it("rolls undeclared keys into metadata_json during backfill", async () => {
        const db = new Database(":memory:");
        freshContent(db);
        db.run("ALTER TABLE t_content ADD COLUMN category TEXT");
        db.run("INSERT INTO t_content (id, source_id) VALUES ('c1', 's1')");

        const source: IndexerSource = {
            scan: async () => [],
            detectChanges: () => ({ added: [], modified: [], deleted: [], unchanged: [] }),
            hashEntry: () => "h",
            metadataColumns: () => [{ name: "category", type: "TEXT" }],
            async *populateMetadata(opts) {
                yield opts.entries.map((e) => ({
                    sourceId: e.sourceId,
                    metadata: { category: "blog", flagged: true, threadId: "T1" },
                }));
            },
        };

        await backfillMetadataColumns(db, "t", source, [{ name: "category", type: "TEXT" }]);

        const row = db.query("SELECT category, metadata_json FROM t_content WHERE id = 'c1'").get() as {
            category: string;
            metadata_json: string;
        };
        expect(row.category).toBe("blog");
        const bag = SafeJSON.parse(row.metadata_json) as Record<string, unknown>;
        expect(bag.threadId).toBe("T1");
        expect(bag.category).toBeUndefined(); // typed col, not in bag
        db.close();
    });

    it("preserves existing metadata_json keys while backfilling new typed columns", async () => {
        const db = new Database(":memory:");
        freshContent(db);
        db.run("ALTER TABLE t_content ADD COLUMN score REAL");
        db.run("INSERT INTO t_content (id, source_id, metadata_json) VALUES ('c1', 's1', '{\"existing\":true}')");

        const source: IndexerSource = {
            scan: async () => [],
            detectChanges: () => ({ added: [], modified: [], deleted: [], unchanged: [] }),
            hashEntry: () => "h",
            async *populateMetadata(opts) {
                yield opts.entries.map((e) => ({
                    sourceId: e.sourceId,
                    metadata: { score: 0.9, fresh: "yes" },
                }));
            },
        };

        await backfillMetadataColumns(db, "t", source, [{ name: "score", type: "REAL" }]);

        const row = db.query("SELECT score, metadata_json FROM t_content WHERE id = 'c1'").get() as {
            score: number;
            metadata_json: string;
        };
        expect(row.score).toBe(0.9);
        const bag = SafeJSON.parse(row.metadata_json) as Record<string, unknown>;
        expect(bag.existing).toBe(true);
        expect(bag.fresh).toBe("yes");
        db.close();
    });

    it("does not overwrite omitted typed columns with NULL during backfill", async () => {
        const db = new Database(":memory:");
        freshContent(db);
        db.run("ALTER TABLE t_content ADD COLUMN score REAL");
        db.run("ALTER TABLE t_content ADD COLUMN category TEXT DEFAULT 'uncategorized'");
        db.run("INSERT INTO t_content (id, source_id, score, category) VALUES ('c1', 's1', 0.7, 'existing')");

        const source: IndexerSource = {
            scan: async () => [],
            detectChanges: () => ({ added: [], modified: [], deleted: [], unchanged: [] }),
            hashEntry: () => "h",
            async *populateMetadata(opts) {
                yield opts.entries.map((e) => ({
                    sourceId: e.sourceId,
                    metadata: { fresh: "yes" },
                }));
            },
        };

        await backfillMetadataColumns(db, "t", source, [
            { name: "score", type: "REAL" },
            { name: "category", type: "TEXT", default: "uncategorized" },
        ]);

        const row = db.query("SELECT score, category, metadata_json FROM t_content WHERE id = 'c1'").get() as {
            score: number;
            category: string;
            metadata_json: string;
        };
        expect(row.score).toBe(0.7);
        expect(row.category).toBe("existing");
        const bag = SafeJSON.parse(row.metadata_json) as Record<string, unknown>;
        expect(bag.fresh).toBe("yes");
        db.close();
    });
});
