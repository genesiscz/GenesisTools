import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import type { SearchEngine, SearchOptions, SearchResult } from "../../types";
import { createEmbeddingTable, createFTS5Table } from "./schema";
import { removeEmbedding, storeEmbedding, vectorSearch } from "./vector";

export interface FTS5TableOverrides {
    /** Override the content table name (default: `${tableName}_content`) */
    contentTable?: string;
    /** Override the FTS virtual table name (default: `${tableName}_fts`) */
    ftsTable?: string;
    /** Override the embeddings table name (default: `${tableName}_embeddings`) */
    embeddingsTable?: string;
    /** Column name for the doc ID in the embeddings table (default: `doc_id`) */
    embeddingsDocIdColumn?: string;
}

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
    /** Override default table names for existing schemas */
    tableOverrides?: FTS5TableOverrides;
    /** Skip schema creation (tables already exist) */
    skipSchemaInit?: boolean;
}

export class FTS5SearchEngine<TDoc extends Record<string, unknown> = Record<string, unknown>>
    implements SearchEngine<TDoc>
{
    private db: Database;
    private config: FTS5SearchEngineConfig<TDoc>;
    private embedder?: Embedder;
    private docCount = 0;
    private ownsDb: boolean;

    constructor(config: FTS5SearchEngineConfig<TDoc>) {
        this.config = config;
        this.embedder = config.embedder;
        this.ownsDb = true;

        const dir = dirname(config.dbPath);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(config.dbPath);
        this.db.run("PRAGMA journal_mode = WAL");

        if (!config.skipSchemaInit) {
            this.initSchema();
        }

        this.docCount = this.queryCount();
    }

    /**
     * Create an FTS5SearchEngine on an existing Database instance.
     * Use this when the database is owned by another component (e.g. TelegramHistoryStore)
     * and already has FTS5/embedding tables set up.
     */
    static fromDatabase<T extends Record<string, unknown>>(
        db: Database,
        config: Omit<FTS5SearchEngineConfig<T>, "dbPath">
    ): FTS5SearchEngine<T> {
        const engine = Object.create(FTS5SearchEngine.prototype) as FTS5SearchEngine<T>;
        engine.db = db;
        engine.config = { ...config, dbPath: "" };
        engine.embedder = config.embedder;
        engine.ownsDb = false;

        if (!config.skipSchemaInit) {
            engine.initSchema();
        }

        engine.docCount = engine.queryCount();
        return engine;
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
        const docId = String(id);

        this.db.run(`DELETE FROM ${this.contentTableName} WHERE id = ?`, [docId]);

        if (this.embedder) {
            removeEmbedding(this.db, this.config.tableName, docId);
        }

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
        if (this.ownsDb) {
            this.db.close();
        }
    }

    private get contentTableName(): string {
        return this.config.tableOverrides?.contentTable ?? `${this.config.tableName}_content`;
    }

    private get ftsTableName(): string {
        return this.config.tableOverrides?.ftsTable ?? `${this.config.tableName}_fts`;
    }

    private get embTableName(): string {
        return this.config.tableOverrides?.embeddingsTable ?? `${this.config.tableName}_embeddings`;
    }

    private get embDocIdColumn(): string {
        return this.config.tableOverrides?.embeddingsDocIdColumn ?? "doc_id";
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
        const { textFields, idField } = this.config.schema;
        const docId = String(doc[idField]);

        const columns = ["id", ...textFields];
        const placeholders = columns.map(() => "?").join(", ");
        const values = [docId, ...textFields.map((f) => String(doc[f] ?? ""))];

        this.db.run(`INSERT OR REPLACE INTO ${this.contentTableName} (${columns.join(", ")}) VALUES (${placeholders})`, values);

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

    bm25Search(
        query: string,
        limit: number,
        boost?: Record<string, number>,
        filters?: { sql: string; params: Array<string | number> }
    ): SearchResult<TDoc>[] {
        const ftsTable = this.ftsTableName;
        const contentTable = this.contentTableName;

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

        const filterClause = filters?.sql ? ` AND ${filters.sql}` : "";
        const filterParams = filters?.params ?? [];

        const sql = `
            SELECT c.*, ${rankExpr} AS rank
            FROM ${ftsTable} fts
            JOIN ${contentTable} c ON c.rowid = fts.rowid
            WHERE ${ftsTable} MATCH ?${filterClause}
            ORDER BY rank
            LIMIT ?
        `;

        const rows = this.db
            .query(sql)
            .all(ftsQuery, ...filterParams, limit) as Array<Record<string, unknown> & { rank: number }>;

        return rows.map((row) => {
            const { rank, ...rest } = row;
            return {
                doc: rest as TDoc,
                score: -rank,
                method: "bm25" as const,
            };
        });
    }

    /**
     * Vector cosine search using a pre-computed query embedding.
     * When called with a string query, the embedder is used to generate the embedding.
     * When called with a Float32Array, it's used directly (useful when embeddings are generated externally).
     */
    async cosineSearch(
        query: string | Float32Array,
        limit: number,
        filters?: { sql: string; params: Array<string | number> }
    ): Promise<SearchResult<TDoc>[]> {
        let queryVec: Float32Array;

        if (query instanceof Float32Array) {
            queryVec = query;
        } else {
            if (!this.embedder) {
                throw new Error("Vector search requires an embedder or a pre-computed embedding");
            }

            const queryResult = await this.embedder.embed(query);
            queryVec = queryResult.vector;
        }

        const hits = vectorSearch(
            this.db,
            this.config.tableName,
            queryVec,
            filters ? limit * 5 : limit,
            { table: this.embTableName, docIdColumn: this.embDocIdColumn }
        );

        const filterClause = filters?.sql ? ` AND ${filters.sql}` : "";
        const filterParams = filters?.params ?? [];
        const results: SearchResult<TDoc>[] = [];

        for (const hit of hits) {
            const doc = this.db
                .query(`SELECT c.* FROM ${this.contentTableName} c WHERE c.${this.config.schema.idField} = ?${filterClause}`)
                .get(hit.docId, ...filterParams) as TDoc | null;

            if (doc) {
                results.push({
                    doc,
                    score: 1 - hit.distance,
                    method: "cosine",
                });
            }

            if (results.length >= limit) {
                break;
            }
        }

        return results;
    }

    async rrfHybridSearch(opts: {
        query: string;
        queryEmbedding?: Float32Array;
        limit: number;
        boost?: Record<string, number>;
        weights?: { text: number; vector: number };
        filters?: { sql: string; params: Array<string | number> };
    }): Promise<SearchResult<TDoc>[]> {
        const K = 60;
        const textWeight = opts.weights?.text ?? 1.0;
        const vectorWeight = opts.weights?.vector ?? 1.0;

        const bm25Results = this.bm25Search(opts.query, 100, opts.boost, opts.filters);

        const vectorQuery = opts.queryEmbedding ?? opts.query;
        const vecResults = await this.cosineSearch(vectorQuery, 100, opts.filters);

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
            .slice(0, opts.limit)
            .map((entry) => ({
                doc: entry.doc,
                score: entry.score,
                method: "rrf" as const,
            }));
    }

    private async hybridSearch(
        query: string,
        limit: number,
        boost?: Record<string, number>,
        weights?: { text: number; vector: number }
    ): Promise<SearchResult<TDoc>[]> {
        return this.rrfHybridSearch({ query, limit, boost, weights });
    }

    private queryCount(): number {
        const row = this.db.query(`SELECT COUNT(*) AS cnt FROM ${this.contentTableName}`).get() as { cnt: number };
        return row.cnt;
    }
}
