import type { Migration } from "@app/utils/database/migrations";

const sourceIdIndex: Migration = {
    id: "2026-04-source-id-index",
    description: "B-tree index on ${table}_content.source_id for ATTACH-pushdown filter performance.",
    apply(db, ctx) {
        db.run(
            `CREATE INDEX IF NOT EXISTS idx_${ctx.tableName}_content_source_id ON ${ctx.tableName}_content(source_id)`
        );
    },
};

const ftsDiacritics: Migration = {
    id: "2026-04-fts-diacritics",
    description: "Rebuild ${table}_fts with unicode61 remove_diacritics 2 tokenizer.",
    isApplied(db, ctx) {
        const ftsName = `${ctx.tableName}_fts`;
        const row = db.query("SELECT sql FROM sqlite_master WHERE name=?").get(ftsName) as { sql: string } | null;

        if (row === null) {
            return true; // no FTS table, nothing to rebuild
        }

        return /tokenize\s*=\s*'[^']*remove_diacritics\s*2/.test(row.sql);
    },
    apply(db, ctx) {
        const ftsName = `${ctx.tableName}_fts`;
        const contentName = `${ctx.tableName}_content`;
        const exists = db.query("SELECT name FROM sqlite_master WHERE name=?").get(ftsName);

        if (!exists) {
            return;
        }

        db.transaction(() => {
            db.run(`DROP TABLE ${ftsName}`);
            db.run(`CREATE VIRTUAL TABLE ${ftsName} USING fts5(
                content, name, filePath,
                content=${contentName},
                content_rowid=rowid,
                tokenize='unicode61 remove_diacritics 2'
            )`);
            db.run(
                `INSERT INTO ${ftsName}(rowid, content, name, filePath) SELECT rowid, content, name, filePath FROM ${contentName}`
            );
        })();
    },
};

const metadataJsonColumn: Migration = {
    id: "2026-05-metadata-bag-column",
    description: "Add metadata_json TEXT DEFAULT '{}' column for unindexed source extras.",
    isApplied(db, ctx) {
        const contentName = `${ctx.tableName}_content`;
        const columns = db.prepare(`PRAGMA table_info(${contentName})`).all() as Array<{ name: string }>;
        return columns.some((c) => c.name === "metadata_json");
    },
    apply(db, ctx) {
        const contentName = `${ctx.tableName}_content`;
        db.run(`ALTER TABLE ${contentName} ADD COLUMN metadata_json TEXT DEFAULT '{}'`);
    },
};

export const INDEXER_MIGRATIONS: Migration[] = [sourceIdIndex, ftsDiacritics, metadataJsonColumn];
