import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import logger from "@app/logger";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import { SqliteVectorStore } from "../../stores/sqlite-vector-store";
import type { VectorSearchHit, VectorStore } from "../../stores/vector-store";
import type { SearchEngine as ISearchEngine, SearchOptions, SearchResult } from "../../types";
import { createEmbeddingTable, createFTS5Table } from "./schema";

/**
 * BM25 and cosine scores live on different scales:
 *   - BM25:   ~0.5 to 30+  (higher = more relevant)
 *   - Cosine: 0.0 to 1.0   (higher = more similar)
 *   - RRF:    0.0 to ~0.03 (reciprocal rank fusion scores)
 *
 * When a single minScore is configured, normalize it per mode.
 */
function normalizeMinScore(minScore: number, mode: string): number {
    switch (mode) {
        case "hybrid":
            // RRF scores are tiny (1/(K+rank)), scale down
            return minScore * (1 / 60);
        default:
            // BM25 and cosine: use as-is
            return minScore;
    }
}

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

export interface SearchEngineConfig<TDoc extends Record<string, unknown>> {
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
    /** Override the default SQLite brute-force vector store */
    vectorStore?: VectorStore;
    /** Which vector backend to use. Default: "sqlite-vec" with "sqlite-brute" fallback */
    vectorDriver?: "sqlite-vec" | "sqlite-brute" | "qdrant";
}

export class SearchEngine<TDoc extends Record<string, unknown> = Record<string, unknown>>
    implements ISearchEngine<TDoc>
{
    private db: Database;
    private config: SearchEngineConfig<TDoc>;
    private embedder?: Embedder;
    private _vectorStore?: VectorStore;
    private docCount = 0;
    private ownsDb: boolean;

    constructor(config: SearchEngineConfig<TDoc>) {
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

        this.initStores();
        this.docCount = this.queryCount();
    }

    /**
     * Create a SearchEngine on an existing Database instance.
     * Use this when the database is owned by another component (e.g. TelegramHistoryStore)
     * and already has FTS5/embedding tables set up.
     */
    static fromDatabase<T extends Record<string, unknown>>(
        db: Database,
        config: Omit<SearchEngineConfig<T>, "dbPath">
    ): SearchEngine<T> {
        const engine = Object.create(SearchEngine.prototype) as SearchEngine<T>;
        engine.db = db;
        engine.config = { ...config, dbPath: "" };
        engine.embedder = config.embedder;
        engine.ownsDb = false;

        if (!config.skipSchemaInit) {
            engine.initSchema();
        }

        engine.initStores();
        engine.docCount = engine.queryCount();
        return engine;
    }

    get count(): number {
        return this.docCount;
    }

    /** Public read-only accessor for the underlying vector store */
    getVectorStore(): VectorStore | undefined {
        return this._vectorStore;
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

        if (this._vectorStore) {
            this._vectorStore.remove(docId);
        }

        this.docCount = this.queryCount();
    }

    async search(opts: SearchOptions): Promise<SearchResult<TDoc>[]> {
        const mode = opts.mode ?? "fulltext";
        const limit = opts.limit ?? 20;

        const vectorText = opts.vectorQuery ?? opts.query;
        let results: SearchResult<TDoc>[];

        switch (mode) {
            case "fulltext":
                results = this.bm25Search(opts.query, limit, opts.boost);
                break;
            case "vector":
                results = await this.cosineSearch(vectorText, limit);
                break;
            case "hybrid":
                results = await this.hybridSearch({
                    query: opts.query,
                    vectorQuery: vectorText,
                    limit,
                    boost: opts.boost,
                    weights: opts.hybridWeights,
                });
                break;
            default:
                results = this.bm25Search(opts.query, limit, opts.boost);
        }

        if (opts.minScore !== undefined && opts.minScore > 0) {
            const threshold = normalizeMinScore(opts.minScore, mode);
            results = results.filter((r) => r.score >= threshold);
        }

        return results;
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

    private initStores(): void {
        if (this.config.vectorStore) {
            // Externally provided store (e.g. QdrantVectorStore)
            this._vectorStore = this.config.vectorStore;
            return;
        }

        if (!this.embedder) {
            return;
        }

        const forceDriver = this.config.vectorDriver;

        // If explicitly set to brute-force, skip sqlite-vec attempt
        if (forceDriver === "sqlite-brute") {
            this._vectorStore = new SqliteVectorStore(this.db, {
                tableName: this.config.tableName,
                dimensions: this.embedder.dimensions,
            });
            return;
        }

        // Try sqlite-vec (default or explicit)
        try {
            const { loadSqliteVec } = require("../../stores/sqlite-vec-loader");
            const vecLoaded = loadSqliteVec(this.db);

            if (vecLoaded) {
                const { SqliteVecVectorStore } = require("../../stores/sqlite-vec-store");
                this._vectorStore = new SqliteVecVectorStore(this.db, {
                    tableName: this.config.tableName,
                    dimensions: this.embedder.dimensions,
                });
                return;
            }

            if (forceDriver === "sqlite-vec") {
                throw new Error(
                    "vectorDriver is set to 'sqlite-vec' but the sqlite-vec extension failed to load. " +
                        "Install it with: bun add sqlite-vec"
                );
            }
        } catch (err) {
            if (forceDriver === "sqlite-vec") {
                throw err;
            }

            // Fall through to brute-force
        }

        // Fallback to brute-force
        this._vectorStore = new SqliteVectorStore(this.db, {
            tableName: this.config.tableName,
            dimensions: this.embedder.dimensions,
        });
    }

    private insertSync(doc: TDoc): void {
        const { textFields, idField } = this.config.schema;
        const docId = String(doc[idField]);

        const columns = ["id", ...textFields];
        const placeholders = columns.map(() => "?").join(", ");
        const values = [docId, ...textFields.map((f) => String(doc[f] ?? ""))];

        this.db.run(
            `INSERT OR REPLACE INTO ${this.contentTableName} (${columns.join(", ")}) VALUES (${placeholders})`,
            values
        );

        if (this.embedder && this._vectorStore && this.config.schema.vectorField) {
            const textForEmbed = String(doc[this.config.schema.vectorField] ?? "");

            if (textForEmbed) {
                this.embedder
                    .embed(textForEmbed)
                    .then((result) => {
                        this._vectorStore!.store(docId, result.vector);
                    })
                    .catch((err) => {
                        logger.warn({ err, docId }, "Embedding failed for document (non-fatal, FTS still indexed)");
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

        const rows = this.db.query(sql).all(ftsQuery, ...filterParams, limit) as Array<
            Record<string, unknown> & { rank: number }
        >;

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
        if (!this._vectorStore) {
            throw new Error("Vector search requires an embedder or a pre-computed embedding");
        }

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

        const hits = this._vectorStore.search(queryVec, filters ? limit * 5 : limit);

        const filterClause = filters?.sql ? ` AND ${filters.sql}` : "";
        const filterParams = filters?.params ?? [];
        const results: SearchResult<TDoc>[] = [];

        for (const hit of hits) {
            const doc = this.db
                .query(
                    `SELECT c.* FROM ${this.contentTableName} c WHERE c.${this.config.schema.idField} = ?${filterClause}`
                )
                .get(hit.docId, ...filterParams) as TDoc | null;

            if (doc) {
                results.push({
                    doc,
                    score: hit.score,
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
        vectorQuery?: string;
        limit: number;
        boost?: Record<string, number>;
        weights?: { text: number; vector: number };
        filters?: { sql: string; params: Array<string | number> };
    }): Promise<SearchResult<TDoc>[]> {
        const K = 60;
        const textWeight = opts.weights?.text ?? 1.0;
        const vectorWeight = opts.weights?.vector ?? 1.0;

        // Over-fetch: retrieve 3x candidates per sub-query for better RRF ranking
        const candidatePool = Math.max(opts.limit * 3, 30);

        const bm25Results = this.bm25Search(opts.query, candidatePool, opts.boost, opts.filters);

        const vectorQuery = opts.queryEmbedding ?? opts.vectorQuery ?? opts.query;
        const vecResults = await this.cosineSearch(vectorQuery, candidatePool, opts.filters);

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

    private async hybridSearch(opts: {
        query: string;
        vectorQuery?: string;
        limit: number;
        boost?: Record<string, number>;
        weights?: { text: number; vector: number };
    }): Promise<SearchResult<TDoc>[]> {
        // If using Qdrant with hybrid capability, use server-side RRF
        if (this._vectorStore && this.embedder && "searchHybridAsync" in this._vectorStore) {
            try {
                const queryResult = await this.embedder.embed(opts.vectorQuery ?? opts.query);
                const qdrantStore = this._vectorStore as {
                    searchHybridAsync(searchOpts: {
                        queryVector: Float32Array;
                        queryText: string;
                        limit: number;
                    }): Promise<VectorSearchHit[]>;
                };

                const hits = await qdrantStore.searchHybridAsync({
                    queryVector: queryResult.vector,
                    queryText: opts.query,
                    limit: opts.limit,
                });

                // Resolve doc IDs back to full documents from SQLite content table
                const results: SearchResult<TDoc>[] = [];

                for (const hit of hits) {
                    const doc = this.db
                        .query(`SELECT c.* FROM ${this.contentTableName} c WHERE c.${this.config.schema.idField} = ?`)
                        .get(hit.docId) as TDoc | null;

                    if (doc) {
                        results.push({ doc, score: hit.score, method: "rrf" });
                    }
                }

                return results;
            } catch {
                // Qdrant hybrid failed -- fall back to client-side RRF
            }
        }

        // Default: client-side RRF
        return this.rrfHybridSearch({
            query: opts.query,
            vectorQuery: opts.vectorQuery,
            limit: opts.limit,
            boost: opts.boost,
            weights: opts.weights,
        });
    }

    private queryCount(): number {
        const row = this.db.query(`SELECT COUNT(*) AS cnt FROM ${this.contentTableName}`).get() as { cnt: number };
        return row.cnt;
    }
}
