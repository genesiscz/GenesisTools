import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import type { SearchEngine, SearchOptions, SearchResult } from "../../types";
import { createEmbeddingTable, createFTS5Table } from "./schema";
import { removeEmbedding, storeEmbedding, vectorSearch } from "./vector";

export interface FTS5SearchEngineConfig<TDoc extends Record<string, unknown>> {
    dbPath: string;
    tableName: string;
    schema: {
        textFields: Array<keyof TDoc & string>;
        idField: keyof TDoc & string;
        vectorField?: keyof TDoc & string;
    };
    embedder?: Embedder;
    tokenizer?: string;
}

export class FTS5SearchEngine<TDoc extends Record<string, unknown> = Record<string, unknown>>
    implements SearchEngine<TDoc>
{
    private db: Database;
    private config: FTS5SearchEngineConfig<TDoc>;
    private embedder?: Embedder;
    private docCount = 0;

    constructor(config: FTS5SearchEngineConfig<TDoc>) {
        this.config = config;
        this.embedder = config.embedder;

        const dir = dirname(config.dbPath);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(config.dbPath);
        this.db.run("PRAGMA journal_mode = WAL");
        this.initSchema();
        this.docCount = this.queryCount();
    }

    get count(): number {
        return this.docCount;
    }

    async insert(doc: TDoc): Promise<void> {
        this.insertSync(doc);
    }

    async insertMany(docs: TDoc[]): Promise<void> {
        const tx = this.db.transaction(() => {
            for (const doc of docs) {
                this.insertSync(doc);
            }
        });

        tx();
    }

    async remove(id: string | number): Promise<void> {
        const contentTable = `${this.config.tableName}_content`;
        const docId = String(id);

        this.db.run(`DELETE FROM ${contentTable} WHERE id = ?`, [docId]);
        removeEmbedding(this.db, this.config.tableName, docId);
        this.docCount = this.queryCount();
    }

    async search(opts: SearchOptions): Promise<SearchResult<TDoc>[]> {
        const mode = opts.mode ?? "fulltext";
        const limit = opts.limit ?? 20;

        switch (mode) {
            case "fulltext":
                return this.bm25Search(opts.query, limit, opts.boost);
            case "vector":
                return this.cosineSearch(opts.query, limit);
            case "hybrid":
                return this.hybridSearch(opts.query, limit, opts.boost, opts.hybridWeights);
            default:
                return this.bm25Search(opts.query, limit, opts.boost);
        }
    }

    async persist(): Promise<void> {
        // SQLite is already persisted — no-op
    }

    async close(): Promise<void> {
        this.db.close();
    }

    private initSchema(): void {
        createFTS5Table({
            db: this.db,
            tableName: this.config.tableName,
            fields: this.config.schema.textFields,
            tokenizer: this.config.tokenizer,
        });

        if (this.embedder) {
            createEmbeddingTable(this.db, this.config.tableName, this.embedder.dimensions);
        }
    }

    private insertSync(doc: TDoc): void {
        const contentTable = `${this.config.tableName}_content`;
        const { textFields, idField } = this.config.schema;
        const docId = String(doc[idField]);

        const columns = ["id", ...textFields];
        const placeholders = columns.map(() => "?").join(", ");
        const values = [docId, ...textFields.map((f) => String(doc[f] ?? ""))];

        this.db.run(
            `INSERT OR REPLACE INTO ${contentTable} (${columns.join(", ")}) VALUES (${placeholders})`,
            values
        );

        if (this.embedder && this.config.schema.vectorField) {
            const textForEmbed = String(doc[this.config.schema.vectorField] ?? "");

            if (textForEmbed) {
                this.embedder
                    .embed(textForEmbed)
                    .then((result) => {
                        storeEmbedding(this.db, this.config.tableName, docId, result.vector);
                    })
                    .catch(() => {
                        // Embedding failure is non-fatal
                    });
            }
        }

        this.docCount = this.queryCount();
    }

    private bm25Search(query: string, limit: number, boost?: Record<string, number>): SearchResult<TDoc>[] {
        const ftsTable = `${this.config.tableName}_fts`;
        const contentTable = `${this.config.tableName}_content`;

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
            const { textFields } = this.config.schema;
            const weights = textFields.map((f) => boost[f] ?? 1.0);
            rankExpr = `bm25(${ftsTable}, ${weights.join(", ")})`;
        }

        const sql = `
            SELECT c.*, ${rankExpr} AS rank
            FROM ${ftsTable} fts
            JOIN ${contentTable} c ON c.rowid = fts.rowid
            WHERE ${ftsTable} MATCH ?
            ORDER BY rank
            LIMIT ?
        `;

        const rows = this.db.query(sql).all(ftsQuery, limit) as Array<Record<string, unknown> & { rank: number }>;

        return rows.map((row) => {
            const { rank, ...rest } = row;
            return {
                doc: rest as TDoc,
                score: -rank,
                method: "bm25" as const,
            };
        });
    }

    private async cosineSearch(query: string, limit: number): Promise<SearchResult<TDoc>[]> {
        if (!this.embedder) {
            throw new Error("Vector search requires an embedder");
        }

        const contentTable = `${this.config.tableName}_content`;
        const queryResult = await this.embedder.embed(query);
        const hits = vectorSearch(this.db, this.config.tableName, queryResult.vector, limit);

        const results: SearchResult<TDoc>[] = [];

        for (const hit of hits) {
            const doc = this.db.query(`SELECT * FROM ${contentTable} WHERE id = ?`).get(hit.docId) as TDoc | null;

            if (doc) {
                results.push({
                    doc,
                    score: 1 - hit.distance,
                    method: "cosine",
                });
            }
        }

        return results;
    }

    private async hybridSearch(
        query: string,
        limit: number,
        boost?: Record<string, number>,
        weights?: { text: number; vector: number }
    ): Promise<SearchResult<TDoc>[]> {
        const K = 60;
        const textWeight = weights?.text ?? 1.0;
        const vectorWeight = weights?.vector ?? 1.0;

        const bm25Results = this.bm25Search(query, 100, boost);
        const vecResults = await this.cosineSearch(query, 100);

        const scores = new Map<string, { score: number; doc: TDoc }>();

        for (let i = 0; i < bm25Results.length; i++) {
            const r = bm25Results[i];
            const docId = String((r.doc as Record<string, unknown>)[this.config.schema.idField]);
            const rrfScore = textWeight / (K + i + 1);
            const existing = scores.get(docId);

            if (existing) {
                existing.score += rrfScore;
            } else {
                scores.set(docId, { score: rrfScore, doc: r.doc });
            }
        }

        for (let i = 0; i < vecResults.length; i++) {
            const r = vecResults[i];
            const docId = String((r.doc as Record<string, unknown>)[this.config.schema.idField]);
            const rrfScore = vectorWeight / (K + i + 1);
            const existing = scores.get(docId);

            if (existing) {
                existing.score += rrfScore;
            } else {
                scores.set(docId, { score: rrfScore, doc: r.doc });
            }
        }

        return [...scores.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((entry) => ({
                doc: entry.doc,
                score: entry.score,
                method: "rrf" as const,
            }));
    }

    private queryCount(): number {
        const contentTable = `${this.config.tableName}_content`;
        const row = this.db.query(`SELECT COUNT(*) AS cnt FROM ${contentTable}`).get() as { cnt: number };
        return row.cnt;
    }
}
