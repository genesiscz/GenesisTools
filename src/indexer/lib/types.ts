import type { IndexerSource } from "./sources/source";

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
    chunking?: "ast" | "line" | "heading" | "message" | "json" | "auto";
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
        path?: string;
        turbopuffer?: { apiKey?: string; namespace?: string };
        oramaCache?: boolean;
    };

    // Watch / reindex
    watch?: {
        enabled?: boolean;
        strategy?: "git" | "merkle" | "git+merkle" | "chokidar";
        interval?: number;
    };
}

export interface EmbeddingModelInfo {
    model: string;
    provider: string;
    dimensions: number;
    maxEmbedChars?: number;
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
    searchEmbedding?: EmbeddingModelInfo;
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
