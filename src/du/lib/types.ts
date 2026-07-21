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

/** One directory in the `--depth N` tree (flat list; link via `parent`). */
export interface NodeResult {
    path: string;
    depth: number;
    /** Parent node index in the `nodes` array; -1 for the root. */
    parent: number;
    naive_bytes: number;
    /** Clone-deduped unique bytes WITHIN this subtree. */
    unique_bytes: number;
    /** Bytes this subtree shares with directories OUTSIDE it. */
    cross_shared_bytes: number;
    shared_pct: number;
    files: number;
    clone_flagged: boolean;
    /** Σ per-file ATTR_CMNEXT_PRIVATESIZE in this subtree (only with --freeable-tree). */
    private_bytes?: number;
}

export interface ClonesizeResult {
    path: string;
    files_scanned: number;
    files_listed: number;
    /** Files actually opened + extent-scanned (< files_scanned when clones are skipped). */
    files_opened?: number;
    /** Present with --depth: the per-directory tree (flat, ordered root-first). */
    depth?: number;
    nodes?: NodeResult[];
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

export type Engine = "c" | "c-ffi" | "bun";

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
    /** --depth N: emit a per-directory tree down to depth N (>=0). Undefined = off. */
    depth?: number;
    /** --freeable-tree: per-node ATTR_CMNEXT_PRIVATESIZE (implies depth>=1). */
    freeableTree?: boolean;
}
