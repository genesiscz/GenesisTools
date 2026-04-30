import type { IndexerSource } from "./sources/source";

/** Default polling watch interval: 5 minutes */
export const DEFAULT_WATCH_INTERVAL_MS = 300_000;

/** Embedding batch size for the embed pipeline */
export const EMBEDDING_BATCH_SIZE = 32;

/** Optimal embedding batch sizes per provider (from benchmarks 2026-04-08). */
export const PROVIDER_BATCH_SIZES: Record<string, number> = {
    ollama: 500,
    google: 100,
    cloud: 2048,
    "local-hf": 32,
    darwinkit: 100,
    coreml: 100,
};

export interface IndexConfig {
    name: string;
    baseDir: string;
    type?: "code" | "files" | "mail" | "chat";

    /** Custom data source (default: FileSource from baseDir) */
    source?: IndexerSource;

    // File filtering
    respectGitIgnore?: boolean;
    ignoredPaths?: string[];
    includedSuffixes?: string[];

    // Chunking
    chunking?: "ast" | "line" | "heading" | "message" | "json" | "character" | "auto";
    chunkMaxTokens?: number;

    // Embedding (enabled by default with auto-fallback: darwinkit → local-hf → cloud)
    embedding?: {
        enabled?: boolean; // default: true
        provider?: string;
        model?: string;
    };

    // Storage
    storage?: {
        driver?: "sqlite" | "orama" | "turbopuffer";
        /** Vector search backend. Default: "sqlite-vec" with "sqlite-brute" fallback */
        vectorDriver?: "sqlite-vec" | "sqlite-brute" | "qdrant";
        path?: string;
        turbopuffer?: { apiKey?: string; namespace?: string };
        oramaCache?: boolean;
        /** Qdrant connection config (only used when vectorDriver = "qdrant") */
        qdrant?: { url: string; apiKey?: string; collectionName?: string };
    };

    // Search tuning
    search?: {
        /** Minimum score threshold for search results. Default: 0 (no filtering) */
        minScore?: number;
        /** Hybrid search weights */
        hybridWeights?: { text: number; vector: number };
    };

    // Watch / reindex
    watch?: {
        enabled?: boolean;
        strategy?: "native" | "polling" | "git" | "merkle" | "git+merkle" | "chokidar";
        interval?: number;
        /** Debounce for native watcher in ms. Default: 2000 */
        debounceMs?: number;
        /** Auto-start watcher after sync completes. Default: false */
        autoStart?: boolean;
    };
}

export interface EmbeddingModelInfo {
    model: string;
    provider: string;
    dimensions: number;
    maxEmbedChars?: number;
}

export interface MetadataColumnSpec {
    /** Column name; must be a SQL-safe identifier ([A-Za-z_][A-Za-z0-9_]*). */
    name: string;
    /** SQLite storage class. */
    type: "INTEGER" | "TEXT" | "REAL";
    /** When true, library creates a B-tree index on the column. */
    indexed?: boolean;
    /** When true, column is NOT NULL with the given default. */
    notNull?: boolean;
    /** SQL DEFAULT value (literal). */
    default?: number | string;
}

export function emptyStats(): IndexStats {
    return {
        totalFiles: 0,
        totalChunks: 0,
        totalEmbeddings: 0,
        embeddingDimensions: 0,
        dbSizeBytes: 0,
        lastSyncDurationMs: 0,
        searchCount: 0,
        avgSearchDurationMs: 0,
    };
}

export interface IndexMeta {
    name: string;
    config: IndexConfig;
    stats: IndexStats;
    lastSyncAt: number | null;
    createdAt: number;
    indexEmbedding?: EmbeddingModelInfo;
    /** @todo Not yet populated -- reserved for separate search-time embedding model */
    searchEmbedding?: EmbeddingModelInfo;
    /** Current indexing status. Persisted for crash recovery. */
    indexingStatus?: "idle" | "in-progress" | "completed" | "cancelled" | "error";
    /** Source-declared filterable metadata columns currently materialized in this index. */
    metadataColumns?: MetadataColumnSpec[];
}

export interface IndexStats {
    totalFiles: number;
    totalChunks: number;
    totalEmbeddings: number;
    embeddingDimensions: number;
    dbSizeBytes: number;
    lastSyncDurationMs: number;
    searchCount: number;
    avgSearchDurationMs: number;
}

export interface ChunkRecord {
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    kind: string;
    name?: string;
    language?: string;
    parentChunkId?: string;
    /** Source-specific metadata (mail: sender, date, read; telegram: chat, direction) */
    metadata?: Record<string, unknown>;
    /** Original source entry ID (ROWID for mail, file path for files) */
    sourceId?: string;
}

export interface MerkleNode {
    hash: string;
    path: string;
    children?: MerkleNode[];
    isFile?: boolean;
    chunkHashes?: string[];
}
