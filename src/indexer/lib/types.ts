export interface IndexConfig {
    name: string;
    baseDir: string;
    type?: "code" | "files" | "mail" | "chat";

    // File filtering
    respectGitIgnore?: boolean;
    ignoredPaths?: string[];
    includedSuffixes?: string[];

    // Chunking
    chunking?: "ast" | "line" | "heading" | "message" | "json" | "auto";
    chunkMaxTokens?: number;

    // Embedding
    embedding?: {
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

export interface IndexMeta {
    name: string;
    config: IndexConfig;
    stats: IndexStats;
    lastSyncAt: number | null;
    createdAt: number;
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
}

export interface MerkleNode {
    hash: string;
    path: string;
    children?: MerkleNode[];
    isFile?: boolean;
    chunkHashes?: string[];
}
