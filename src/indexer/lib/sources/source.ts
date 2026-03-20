export interface SourceEntry {
    /** Unique identifier -- file path for files, rowid for mail, message_id for chat */
    id: string;
    /** Text content to chunk and embed */
    content: string;
    /** Display path for search results */
    path: string;
    /** Optional metadata for filtering */
    metadata?: Record<string, unknown>;
}

export interface SourceChanges {
    added: SourceEntry[];
    modified: SourceEntry[];
    deleted: string[];
    unchanged: string[];
}

export interface ScanOptions {
    onProgress?: (current: number, total: number) => void;
    limit?: number;
    /** Only return entries newer than this ID (for resumable/incremental sources like mail) */
    sinceId?: string;
    /** Process entries in batches as they're scanned (survives cancellation) */
    onBatch?: (entries: SourceEntry[]) => Promise<void>;
    /** Batch size for onBatch (default: 500) */
    batchSize?: number;
}

export interface DetectChangesOptions {
    /** Previous hashes from PathHashStore, or null for first sync */
    previousHashes: Map<string, string> | null;
    /** Current entries from scan() */
    currentEntries: SourceEntry[];
    /** Whether to force full reindex (ignore previous state) */
    full?: boolean;
}

export interface IndexerSource {
    /** Scan for all indexable content */
    scan(opts?: ScanOptions): Promise<SourceEntry[]>;

    /** Determine what changed since last sync */
    detectChanges(opts: DetectChangesOptions): SourceChanges;

    /** Estimate total items for progress display (optional) */
    estimateTotal?(): Promise<number>;

    /** Compute a content hash for a source entry (for Merkle/change detection) */
    hashEntry(entry: SourceEntry): string;
}
