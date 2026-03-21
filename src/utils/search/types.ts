import type { Embedder } from "@app/utils/ai/tasks/Embedder";

export interface SearchEngine<TDoc extends Record<string, unknown> = Record<string, unknown>> {
    insert(doc: TDoc): Promise<void>;
    insertMany(docs: TDoc[]): Promise<void>;
    remove(id: string | number): Promise<void>;
    search(opts: SearchOptions): Promise<SearchResult<TDoc>[]>;
    persist?(): Promise<void>;
    close?(): Promise<void>;
    readonly count: number;
}

export interface SearchOptions {
    query: string;
    mode?: "fulltext" | "vector" | "hybrid";
    limit?: number;
    fields?: string[];
    boost?: Record<string, number>;
    hybridWeights?: { text: number; vector: number };
    filters?: Record<string, unknown>;
    /** Override the text used for vector embedding (e.g., with a task prefix). FTS still uses `query`. */
    vectorQuery?: string;
    /** Minimum score threshold -- results below this are filtered out. Default: no filtering. */
    minScore?: number;
}

export interface SearchResult<TDoc> {
    doc: TDoc;
    score: number;
    method: "bm25" | "cosine" | "rrf";
}

export interface SearchEngineConfig {
    embedder?: Embedder;
}
