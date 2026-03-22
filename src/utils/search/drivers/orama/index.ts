import {
    count,
    create,
    insert as oramaInsert,
    insertMultiple,
    remove as oramaRemove,
    search as oramaSearch,
    searchVector,
} from "@orama/orama";
import type { AnyOrama, AnySchema, SearchParams } from "@orama/orama";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import type { SearchEngine, SearchOptions, SearchResult } from "../../types";
import { persistToFile, restoreFromFile } from "./persistence";

interface OramaHit {
    id: string;
    score: number;
    document: Record<string, unknown>;
}

export interface OramaSearchEngineConfig {
    schema: AnySchema;
    persistPath?: string;
    embedder?: Embedder;
    vectorProperty?: string;
    idProperty?: string;
}

export class OramaSearchEngine<TDoc extends Record<string, unknown> = Record<string, unknown>>
    implements SearchEngine<TDoc>
{
    private db: AnyOrama | null = null;
    private config: OramaSearchEngineConfig;
    private embedder?: Embedder;
    private initialized = false;

    constructor(config: OramaSearchEngineConfig) {
        this.config = config;
        this.embedder = config.embedder;
    }

    get count(): number {
        if (!this.db) {
            return 0;
        }

        return count(this.db);
    }

    async insert(doc: TDoc): Promise<void> {
        const db = await this.ensureDb();
        await oramaInsert(db, doc);
    }

    async insertMany(docs: TDoc[]): Promise<void> {
        const db = await this.ensureDb();
        await insertMultiple(db, docs);
    }

    async remove(id: string | number): Promise<void> {
        const db = await this.ensureDb();
        await oramaRemove(db, String(id));
    }

    async search(opts: SearchOptions): Promise<SearchResult<TDoc>[]> {
        const db = await this.ensureDb();
        const mode = opts.mode ?? "fulltext";
        const limit = opts.limit ?? 20;

        switch (mode) {
            case "fulltext":
                return this.fulltextSearch(db, opts, limit);
            case "vector":
                return this.vectorSearchMode(db, opts, limit);
            case "hybrid":
                return this.hybridSearchMode(db, opts, limit);
            default:
                return this.fulltextSearch(db, opts, limit);
        }
    }

    async persist(): Promise<void> {
        if (!this.db || !this.config.persistPath) {
            return;
        }

        await persistToFile(this.db, this.config.persistPath);
    }

    async close(): Promise<void> {
        if (this.config.persistPath && this.db) {
            await persistToFile(this.db, this.config.persistPath);
        }

        this.db = null;
        this.initialized = false;
    }

    private async ensureDb(): Promise<AnyOrama> {
        if (this.db && this.initialized) {
            return this.db;
        }

        if (this.config.persistPath) {
            const restored = await restoreFromFile(this.config.persistPath);

            if (restored) {
                this.db = restored;
                this.initialized = true;
                return this.db;
            }
        }

        this.db = create({ schema: this.config.schema });
        this.initialized = true;
        return this.db;
    }

    private async fulltextSearch(db: AnyOrama, opts: SearchOptions, limit: number): Promise<SearchResult<TDoc>[]> {
        const params: SearchParams<AnyOrama> = {
            term: opts.query,
            limit,
            properties: opts.fields,
            boost: opts.boost as Record<string, number>,
        };

        const results = await oramaSearch(db, params);
        return this.mapHits(results.hits as unknown as OramaHit[], "bm25");
    }

    private async vectorSearchMode(db: AnyOrama, opts: SearchOptions, limit: number): Promise<SearchResult<TDoc>[]> {
        if (!this.embedder) {
            throw new Error("Vector search requires an embedder");
        }

        const vectorProperty = this.config.vectorProperty;

        if (!vectorProperty) {
            throw new Error("Vector search requires a vectorProperty in config");
        }

        const queryResult = await this.embedder.embed(opts.query);

        const results = await searchVector(db, {
            vector: {
                value: Array.from(queryResult.vector),
                property: vectorProperty,
            },
            limit,
            mode: "vector",
        });

        return this.mapHits(results.hits as unknown as OramaHit[], "cosine");
    }

    private async hybridSearchMode(db: AnyOrama, opts: SearchOptions, limit: number): Promise<SearchResult<TDoc>[]> {
        if (!this.embedder) {
            throw new Error("Hybrid search requires an embedder");
        }

        const vectorProperty = this.config.vectorProperty;

        if (!vectorProperty) {
            throw new Error("Hybrid search requires a vectorProperty in config");
        }

        const queryResult = await this.embedder.embed(opts.query);
        const weights = opts.hybridWeights ?? { text: 0.5, vector: 0.5 };

        const params: SearchParams<AnyOrama> = {
            term: opts.query,
            mode: "hybrid",
            vector: {
                value: Array.from(queryResult.vector),
                property: vectorProperty,
            },
            limit,
            properties: opts.fields,
            boost: opts.boost as Record<string, number>,
            hybridWeights: { text: weights.text, vector: weights.vector },
        };

        const results = await oramaSearch(db, params);
        return this.mapHits(results.hits as unknown as OramaHit[], "rrf");
    }

    private mapHits(hits: OramaHit[], method: "bm25" | "cosine" | "rrf"): SearchResult<TDoc>[] {
        return hits.map((hit) => ({
            doc: hit.document as TDoc,
            score: hit.score,
            method,
        }));
    }
}
