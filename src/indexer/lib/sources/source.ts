import { detectChangesPreHashed } from "@app/utils/fs/change-detector";

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
    /** Only include entries on or after this date */
    fromDate?: Date;
    /** Only include entries on or before this date */
    toDate?: Date;
}

export interface DetectChangesOptions {
    /** Previous hashes from PathHashStore, or null for first sync */
    previousHashes: Map<string, string> | null;
    /** Current entries from scan() */
    currentEntries: SourceEntry[];
    /** Whether to force full reindex (ignore previous state) */
    full?: boolean;
}

/** Default change detection — shared across all sources, delegates to ChangeDetector */
export function defaultDetectChanges(
    opts: DetectChangesOptions,
    hashFn: (entry: SourceEntry) => string
): SourceChanges {
    const { previousHashes, currentEntries, full } = opts;

    if (!previousHashes || full) {
        return { added: currentEntries, modified: [], deleted: [], unchanged: [] };
    }

    // Build current hash map and entry lookup
    const currentHashMap = new Map<string, string>();
    const entryById = new Map<string, SourceEntry>();

    for (const entry of currentEntries) {
        currentHashMap.set(entry.id, hashFn(entry));
        entryById.set(entry.id, entry);
    }

    const changeSet = detectChangesPreHashed(currentHashMap, previousHashes);

    return {
        added: changeSet.added.map((id) => entryById.get(id)!),
        modified: changeSet.modified.map((id) => entryById.get(id)!),
        deleted: changeSet.deleted,
        unchanged: changeSet.unchanged,
    };
}

/** Default content hash using xxHash64 (consistent with chunker) */
export function defaultHashEntry(entry: SourceEntry): string {
    return Bun.hash(entry.content).toString(16);
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

    /** Release resources (DB connections, file handles) */
    dispose?(): void;
}
