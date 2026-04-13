import type { Database } from "bun:sqlite";

export function createFTS5Table(opts: { db: Database; tableName: string; fields: string[]; tokenizer?: string }): void {
    const { db, tableName, fields, tokenizer } = opts;
    const contentTable = `${tableName}_content`;
    const ftsTable = `${tableName}_fts`;
    // remove_diacritics 2 folds é/à/ř/ž/etc. to the ASCII form so
    // "zarizeni" matches "zařízení". Only applies to newly CREATEd FTS5 tables.
    const tokenizerClause = tokenizer ?? "unicode61 remove_diacritics 2";

    db.run(`CREATE TABLE IF NOT EXISTS ${contentTable} (
        id TEXT PRIMARY KEY,
        ${fields.map((f) => `${f} TEXT`).join(",\n        ")}
    )`);

    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(
        ${fields.join(", ")},
        content=${contentTable},
        content_rowid=rowid,
        tokenize='${tokenizerClause}'
    )`);

    for (const trigger of buildSyncTriggers({ contentTable, ftsTable, fields })) {
        try {
            db.run(trigger);
        } catch (error) {
            if (error instanceof Error && error.message.includes("already exists")) {
                continue;
            }

            throw error;
        }
    }
}

/** Legacy brute-force embedding table. Dimensions validated at search time (vectorSearch). */
export function createEmbeddingTable(db: Database, tableName: string, _dimensions?: number): void {
    const embTable = `${tableName}_embeddings`;

    db.run(`CREATE TABLE IF NOT EXISTS ${embTable} (
        doc_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL
    )`);
}

function buildSyncTriggers(opts: { contentTable: string; ftsTable: string; fields: string[] }): string[] {
    const { contentTable, ftsTable, fields } = opts;
    const fieldList = fields.join(", ");
    const newFields = fields.map((f) => `new.${f}`).join(", ");

    return [
        `CREATE TRIGGER ${contentTable}_ai AFTER INSERT ON ${contentTable} BEGIN
            INSERT INTO ${ftsTable}(rowid, ${fieldList}) VALUES (new.rowid, ${newFields});
        END`,
        `CREATE TRIGGER ${contentTable}_ad AFTER DELETE ON ${contentTable} BEGIN
            INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${fieldList}) VALUES('delete', old.rowid, ${fields.map((f) => `old.${f}`).join(", ")});
        END`,
        `CREATE TRIGGER ${contentTable}_au AFTER UPDATE ON ${contentTable} BEGIN
            INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${fieldList}) VALUES('delete', old.rowid, ${fields.map((f) => `old.${f}`).join(", ")});
            INSERT INTO ${ftsTable}(rowid, ${fieldList}) VALUES (new.rowid, ${newFields});
        END`,
    ];
}
