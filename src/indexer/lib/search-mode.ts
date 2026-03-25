import type { Indexer } from "./indexer";

export type SearchMode = "fulltext" | "vector" | "hybrid";

const MODE_ALIASES: Record<string, SearchMode> = {
    semantic: "vector",
};

/**
 * Detect the best search mode for an index.
 * If the index has embeddings -> hybrid (combines BM25 + semantic).
 * Otherwise -> fulltext (BM25 only).
 */
export function detectMode(indexer: Indexer): SearchMode {
    return indexer.getStore().getEmbeddingCount() > 0 ? "hybrid" : "fulltext";
}

/** Resolve a user-provided mode string to a canonical SearchMode. Returns undefined for unknown modes. */
export function resolveSearchMode(input: string): SearchMode | undefined {
    if (input === "fulltext" || input === "vector" || input === "hybrid") {
        return input;
    }

    return MODE_ALIASES[input];
}
