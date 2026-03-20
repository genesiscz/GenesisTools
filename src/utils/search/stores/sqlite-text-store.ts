import type { Database } from "bun:sqlite";
import type { TextSearchHit, TextStore } from "./text-store";

export interface SqliteTextStoreConfig {
    tableName: string;
    fields: string[];
    tokenizer?: string;
}

export class SqliteTextStore implements TextStore {
    private db: Database;
    private contentTable: string;
    private ftsTable: string;
    private fields: string[];

    constructor(db: Database, config: SqliteTextStoreConfig) {
        this.db = db;
        this.fields = config.fields;
        this.contentTable = `${config.tableName}_content`;
        this.ftsTable = `${config.tableName}_fts`;

        this.initSchema(config.tokenizer);
    }

    insert(id: string, fields: Record<string, string>): void {
        const columns = ["id", ...this.fields];
        const placeholders = columns.map(() => "?").join(", ");
        const values = [id, ...this.fields.map((f) => fields[f] ?? "")];

        this.db.run(
            `INSERT OR REPLACE INTO ${this.contentTable} (${columns.join(", ")}) VALUES (${placeholders})`,
            values
        );
    }

    remove(id: string): void {
        this.db.run(`DELETE FROM ${this.contentTable} WHERE id = ?`, [id]);
    }

    search(query: string, limit: number, boost?: Record<string, number>): TextSearchHit[] {
        const ftsQuery = query
            .replace(/['"]/g, "")
            .split(/\s+/)
            .filter(Boolean)
            .map((word) => `"${word}"`)
            .join(" ");

        if (!ftsQuery) {
            return [];
        }

        let rankExpr = "fts.rank";

        if (boost) {
            const weights = this.fields.map((f) => boost[f] ?? 1.0);
            rankExpr = `bm25(${this.ftsTable}, ${weights.join(", ")})`;
        }

        const sql = `
            SELECT c.id, ${rankExpr} AS rank
            FROM ${this.ftsTable} fts
            JOIN ${this.contentTable} c ON c.rowid = fts.rowid
            WHERE ${this.ftsTable} MATCH ?
            ORDER BY rank
            LIMIT ?
        `;

        const rows = this.db.query(sql).all(ftsQuery, limit) as Array<{ id: string; rank: number }>;

        return rows.map((row) => ({
            docId: row.id,
            score: -row.rank,
        }));
    }

    count(): number {
        const row = this.db.query(`SELECT COUNT(*) AS cnt FROM ${this.contentTable}`).get() as { cnt: number };
        return row.cnt;
    }

    private initSchema(tokenizer?: string): void {
        const tokenizerClause = tokenizer ?? "unicode61";

        this.db.run(`CREATE TABLE IF NOT EXISTS ${this.contentTable} (
            id TEXT PRIMARY KEY,
            ${this.fields.map((f) => `${f} TEXT`).join(",\n            ")}
        )`);

        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.ftsTable} USING fts5(
            ${this.fields.join(", ")},
            content=${this.contentTable},
            content_rowid=rowid,
            tokenize='${tokenizerClause}'
        )`);

        const fieldList = this.fields.join(", ");
        const newFields = this.fields.map((f) => `new.${f}`).join(", ");
        const oldFields = this.fields.map((f) => `old.${f}`).join(", ");

        const triggers = [
            `CREATE TRIGGER ${this.contentTable}_ai AFTER INSERT ON ${this.contentTable} BEGIN
                INSERT INTO ${this.ftsTable}(rowid, ${fieldList}) VALUES (new.rowid, ${newFields});
            END`,
            `CREATE TRIGGER ${this.contentTable}_ad AFTER DELETE ON ${this.contentTable} BEGIN
                INSERT INTO ${this.ftsTable}(${this.ftsTable}, rowid, ${fieldList}) VALUES('delete', old.rowid, ${oldFields});
            END`,
            `CREATE TRIGGER ${this.contentTable}_au AFTER UPDATE ON ${this.contentTable} BEGIN
                INSERT INTO ${this.ftsTable}(${this.ftsTable}, rowid, ${fieldList}) VALUES('delete', old.rowid, ${oldFields});
                INSERT INTO ${this.ftsTable}(rowid, ${fieldList}) VALUES (new.rowid, ${newFields});
            END`,
        ];

        for (const trigger of triggers) {
            try {
                this.db.run(trigger);
            } catch {
                // trigger already exists
            }
        }
    }
}
