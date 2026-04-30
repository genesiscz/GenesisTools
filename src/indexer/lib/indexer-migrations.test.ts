import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runMigrations } from "@app/utils/database/migrations";
import { INDEXER_MIGRATIONS } from "./indexer-migrations";

describe("INDEXER_MIGRATIONS list", () => {
    it("contains source_id index migration", () => {
        const ids = INDEXER_MIGRATIONS.map((m) => m.id);
        expect(ids).toContain("2026-04-source-id-index");
    });

    it("contains FTS diacritics migration", () => {
        const ids = INDEXER_MIGRATIONS.map((m) => m.id);
        expect(ids).toContain("2026-04-fts-diacritics");
    });

    it("contains metadata_json migration", () => {
        const ids = INDEXER_MIGRATIONS.map((m) => m.id);
        expect(ids).toContain("2026-05-metadata-bag-column");
    });
});

describe("2026-04-source-id-index migration", () => {
    it("creates idx_<table>_content_source_id when missing", () => {
        const db = new Database(":memory:");
        db.run("CREATE TABLE t_content (id TEXT PRIMARY KEY, source_id TEXT DEFAULT '')");

        const r1 = runMigrations(db, INDEXER_MIGRATIONS, { tableName: "t" });
        expect(r1.applied).toContain("2026-04-source-id-index");

        const idx = db
            .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_t_content_source_id'")
            .get();
        expect(idx).not.toBeNull();
        db.close();
    });

    it("is idempotent", () => {
        const db = new Database(":memory:");
        db.run("CREATE TABLE t_content (id TEXT PRIMARY KEY, source_id TEXT DEFAULT '')");
        runMigrations(db, INDEXER_MIGRATIONS, { tableName: "t" });

        const r2 = runMigrations(db, INDEXER_MIGRATIONS, { tableName: "t" });
        expect(r2.applied).not.toContain("2026-04-source-id-index");
        expect(r2.skipped).toContain("2026-04-source-id-index");
        db.close();
    });
});

describe("2026-04-fts-diacritics migration", () => {
    it("rebuilds FTS5 with remove_diacritics 2 when missing", () => {
        const db = new Database(":memory:");
        db.run(
            "CREATE TABLE t_content (id TEXT PRIMARY KEY, content TEXT, name TEXT, filePath TEXT, source_id TEXT DEFAULT '')"
        );
        db.run(
            "CREATE VIRTUAL TABLE t_fts USING fts5(content, name, filePath, content=t_content, content_rowid=rowid, tokenize='unicode61')"
        );
        db.run("INSERT INTO t_content (id, content, name, filePath) VALUES ('1', 'nahlášení', 'subj', 'p')");
        db.run(
            "INSERT INTO t_fts(rowid, content, name, filePath) SELECT rowid, content, name, filePath FROM t_content"
        );

        const r = runMigrations(db, INDEXER_MIGRATIONS, { tableName: "t" });
        expect(r.applied).toContain("2026-04-fts-diacritics");

        const row = db.query("SELECT sql FROM sqlite_master WHERE name='t_fts'").get() as { sql: string };
        expect(row.sql).toContain("remove_diacritics 2");

        const hit = db.query("SELECT rowid FROM t_fts WHERE t_fts MATCH 'nahlaseni'").all();
        expect(hit.length).toBe(1);
        db.close();
    });

    it("is idempotent (custom isApplied checks the actual tokenizer)", () => {
        const db = new Database(":memory:");
        db.run(
            "CREATE TABLE t_content (id TEXT PRIMARY KEY, content TEXT, name TEXT, filePath TEXT, source_id TEXT DEFAULT '')"
        );
        db.run(
            "CREATE VIRTUAL TABLE t_fts USING fts5(content, name, filePath, content=t_content, content_rowid=rowid, tokenize='unicode61')"
        );

        runMigrations(db, INDEXER_MIGRATIONS, { tableName: "t" });
        const r2 = runMigrations(db, INDEXER_MIGRATIONS, { tableName: "t" });
        expect(r2.skipped).toContain("2026-04-fts-diacritics");
        db.close();
    });

    it("skips when fts table doesn't exist (treated as already-applied)", () => {
        const db = new Database(":memory:");
        db.run(
            "CREATE TABLE u_content (id TEXT PRIMARY KEY, content TEXT, name TEXT, filePath TEXT, source_id TEXT DEFAULT '')"
        );

        const r = runMigrations(db, INDEXER_MIGRATIONS, { tableName: "u" });
        expect(r.applied).not.toContain("2026-04-fts-diacritics");
        expect(r.skipped).toContain("2026-04-fts-diacritics");
        db.close();
    });
});

describe("2026-05-metadata-bag-column migration", () => {
    it("adds metadata_json with '{}' default", () => {
        const db = new Database(":memory:");
        db.run("CREATE TABLE t_content (id TEXT PRIMARY KEY, source_id TEXT DEFAULT '')");

        const r = runMigrations(db, INDEXER_MIGRATIONS, { tableName: "t" });
        expect(r.applied).toContain("2026-05-metadata-bag-column");

        const col = db
            .query("PRAGMA table_info(t_content)")
            .all()
            .find((row) => {
                return (row as { name: string }).name === "metadata_json";
            }) as { name: string; type: string; dflt_value: string } | undefined;
        expect(col?.type).toBe("TEXT");
        expect(col?.dflt_value).toBe("'{}'");

        db.run("INSERT INTO t_content (id, source_id) VALUES ('c1', 's1')");
        const row = db.query("SELECT metadata_json FROM t_content WHERE id = 'c1'").get() as {
            metadata_json: string;
        };
        expect(row.metadata_json).toBe("{}");
        db.close();
    });

    it("is idempotent by checking the actual content table schema", () => {
        const db = new Database(":memory:");
        db.run(
            "CREATE TABLE t_content (id TEXT PRIMARY KEY, source_id TEXT DEFAULT '', metadata_json TEXT DEFAULT '{}')"
        );

        const r = runMigrations(db, INDEXER_MIGRATIONS, { tableName: "t" });
        expect(r.applied).not.toContain("2026-05-metadata-bag-column");
        expect(r.skipped).toContain("2026-05-metadata-bag-column");
        db.close();
    });
});
