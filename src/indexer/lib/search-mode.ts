import type { Indexer } from "./indexer";

export type SearchMode = "fulltext" | "vector" | "hybrid";

/**
 * Detect the best search mode for an index.
 * If the index has embeddings -> hybrid (combines BM25 + semantic).
 * Otherwise -> fulltext (BM25 only).
 */
export function detectMode(indexer: Indexer): SearchMode {
    return indexer.getStore().getEmbeddingCount() > 0 ? "hybrid" : "fulltext";
}
