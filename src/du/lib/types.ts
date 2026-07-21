// Shared result shape for both the C engine and the Bun engine. The C binary
// emits this exact structure as JSON (see native/clonesize.c); the Bun scanner
// reproduces it byte-for-byte so `bench` can cross-check the two.

export interface GroupResult {
    name: string;
    naive_bytes: number;
    files: number;
    cross_group_shared_bytes: number;
    shared_pct: number;
    clone_cluster: number;
    clone_flagged: boolean;
    private_bytes?: number;
}

export interface ClonesizeResult {
    path: string;
    files_scanned: number;
    files_listed: number;
    extents: number;
    threads: number;
    naive_bytes: number;
    unique_bytes: number;
    shared_bytes: number;
    shared_pct: number;
    cross_group_shared_bytes: number;
    private_sum_bytes?: number;
    groups: GroupResult[];
}

export type Engine = "c" | "bun";

export interface ScanOptions {
    /** Absolute path to scan. */
    path: string;
    /** Worker/thread count. 0 => auto (ncpu). */
    threads?: number;
    /** Also compute Σ per-file ATTR_CMNEXT_PRIVATESIZE. */
    freeable?: boolean;
    /** Skip files whose allocated size < this many bytes. */
    minBytes?: number;
    /** Absolute directory subtrees to prune from the walk. */
    exclude?: string[];
}
