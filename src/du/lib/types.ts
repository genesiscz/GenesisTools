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
    /** Clone-deduped unique MAPPED bytes within this subtree (excludes block slack). */
    unique_bytes: number;
    /** Same dedup, rounded to allocation blocks — what the volume actually spends. */
    unique_allocated_bytes?: number;
    /** Bytes this subtree shares with directories OUTSIDE it. */
    cross_shared_bytes: number;
    /** Same, block-aligned. */
    cross_shared_allocated_bytes?: number;
    shared_pct: number;
    files: number;
    clone_flagged: boolean;
    /** Σ per-file ATTR_CMNEXT_PRIVATESIZE in this subtree. */
    private_bytes?: number;
    /** Lower bound on bytes freed by deleting this subtree (== private_bytes). */
    freeable_floor_bytes?: number;
    /** Upper bound: allocated unique minus what it shares with dirs outside itself. */
    freeable_ceiling_bytes?: number;
    /** Σ datalength — exceeds naive_bytes when the subtree holds sparse files. */
    apparent_bytes?: number;
    /** Σ (datalength − allocsize) over sparse files here. */
    sparse_bytes?: number;
    sparse_files?: number;
}

export interface ClonesizeResult {
    path: string;
    files_scanned: number;
    files_listed: number;
    /** Files actually opened + extent-scanned (< files_scanned when clones are skipped). */
    files_opened?: number;
    /** Shared files whose extent map came from the cache instead of open()+fcntl(). */
    files_cached?: number;
    /** Present with --depth: the per-directory tree (flat, ordered root-first). */
    depth?: number;
    nodes?: NodeResult[];
    extents: number;
    threads: number;
    naive_bytes: number;
    /** Clone-deduped MAPPED bytes (extent scan stops at datalength — no block slack). */
    unique_bytes: number;
    /** Clone-deduped ALLOCATED bytes — the figure the volume's used-space counter agrees with. */
    unique_allocated_bytes?: number;
    /** Σ datalength. Exceeds naive_bytes exactly when sparse files are present. */
    apparent_bytes?: number;
    /** Σ (datalength − allocsize) over sparse files: apparent size never written to disk. */
    sparse_bytes?: number;
    sparse_files?: number;
    shared_bytes: number;
    shared_pct: number;
    cross_group_shared_bytes: number;
    /** Σ per-file ATTR_CMNEXT_PRIVATESIZE — the conservative floor on what deleting frees. */
    private_sum_bytes?: number;
    /**
     * Blocks inside this scan that are ALSO referenced by files outside the scan root.
     * Non-zero means `unique_bytes` is scope-limited: scanning one side of a clone
     * pair reports the clone at full size even though it cost nothing.
     */
    outside_shared_bytes?: number;
    /** Directories the scan could not open (EACCES/EPERM) — their bytes are MISSING from every total. */
    denied_dirs?: number;
    denied_files?: number;
    /** First 64 denied paths, for the report and the sudo hint. */
    denied_paths?: string[];
    /** Mount points of OTHER filesystems inside the scan root, pruned before the walk. */
    skipped_mounts?: string[];
    /** Cloud-provider roots (~/Library/CloudStorage, iCloud Drive) skipped unless --include-cloud. */
    skipped_cloud?: string[];
    /** Epoch seconds cutoff when the scan ran with --changed-within. */
    changed_since?: number;
    groups: GroupResult[];
}

/** Authoritative volume figures straight from the APFS layer (ATTR_VOL_*). */
export interface VolumeInfo {
    mount: string;
    size_bytes: number;
    /** Matches `diskutil info <mount>` → "Volume Used Space". */
    used_bytes: number;
    free_bytes: number;
    available_bytes: number;
}

export interface PartnerEntry {
    path: string;
    shared_bytes: number;
    files?: number;
}

/** Result of `tools du clones <dir>`: who else holds this directory's blocks. */
export interface PartnersResult {
    target: string;
    root: string;
    /** Bytes of the target that live in blocks shared with something else. */
    target_shared_bytes: number;
    /** Σ over partner files (double-counts a block held by several partners). */
    partner_bytes: number;
    partner_files_total: number;
    files_opened: number;
    denied_dirs: number;
    denied_files: number;
    partner_dirs: PartnerEntry[];
    partner_files: PartnerEntry[];
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
    /** --changed-within: only account files with mtime >= this epoch-second cutoff. */
    changedSince?: number;
    /** Directory holding the per-volume extent cache. Undefined disables it entirely. */
    cacheDir?: string;
    /** --no-cache: ignore the cache when reading. It is still WRITTEN, so the next run is warm. */
    noCache?: boolean;
    /** --include-cloud: walk cloud-provider roots too (slow, and can trigger downloads). */
    includeCloud?: boolean;
}
