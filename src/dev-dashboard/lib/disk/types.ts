export interface DiskUsageEntry {
    /** Absolute path that was measured. */
    path: string;
    /** Short human label for the bar list (e.g. "project/node_modules", "~/Library/Caches"). */
    label: string;
    /** Total size in bytes (from `du -sk` × 1024). */
    bytes: number;
}

export interface DiskUsageResult {
    /** False when no allowlist path exists or every `du` failed — mirrors containers' `dockerAvailable`. */
    available: boolean;
    /** ISO timestamp of when the scan ran. */
    scannedAt: string;
    /** Biggest dev dirs, sorted by `bytes` descending (largest first). */
    entries: DiskUsageEntry[];
}
