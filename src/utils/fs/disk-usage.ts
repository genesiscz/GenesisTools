import { createHash } from "node:crypto";
import {
    chmodSync,
    chownSync,
    closeSync,
    type Dirent,
    lstatSync,
    openSync,
    readdirSync,
    readSync,
    renameSync,
    statfsSync,
    statSync,
    unlinkSync,
    utimesSync,
    writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "@app/logger";
import { formatBytes } from "@app/utils/format";
import { CloneUnsupportedError, cloneFile, getCloneId, getFsType, getPrivateSize } from "@app/utils/macos/apfs";
import {
    GetattrlistbulkUnsupportedError,
    isGetattrlistbulkSupported,
    iterDir,
} from "@app/utils/macos/getattrlistbulk";
import { Stopwatch } from "@app/utils/Stopwatch";

export interface WalkEntry {
    path: string;
    logical: number;
    allocated: number;
    /** mtime in nanoseconds (APFS resolution). The walk's stat is already
     *  bigint, so this is free to expose. Past Number.MAX_SAFE_INTEGER, so
     *  must remain a bigint — converting to number loses precision. */
    mtimeNs: bigint;
    /** APFS clone-family id, when the walker fetched it inline (via
     *  `getattrlistbulk`). When set, `findDuplicateFiles` skips its own
     *  `getCloneId(path)` syscall. Undefined when walker fell back to
     *  `readdirSync + statSync` (non-darwin, non-APFS, or `ENOTSUP` per-dir).
     *  Hex string for consistency with `FileMetaEntry.cloneId`; "" or
     *  undefined both mean "no clone-family info available." */
    cloneIdHex?: string;
}

// One-shot probe at module load — `getattrlistbulk` is unavailable off-darwin
// and on non-APFS volumes (returns ENOTSUP). Per-dir fallback handles mixed
// filesystem trees inside a single scan root.
const BULK_AVAILABLE: boolean = (() => {
    if (process.platform !== "darwin") {
        return false;
    }

    try {
        return isGetattrlistbulkSupported();
    } catch {
        return false;
    }
})();

export interface WalkError {
    path: string;
    errno: string;
}

export interface WalkOptions {
    onError?: (err: WalkError) => void;
    /** Return false to skip recursing into this directory. Called with the
     *  absolute path of every subdirectory before it's entered (the root
     *  itself is always entered). Lets callers prune big subtrees
     *  (`node_modules`, `.git`, …) before any syscall is spent on them. */
    shouldEnter?: (dir: string) => boolean;
    /** Aborts the walk between dirent reads. On abort the generator throws
     *  `signal.reason` (or a generic `AbortError` if reason is unset). */
    signal?: AbortSignal;
    /** Called once per directory we successfully read, with its absolute
     *  path. Use a cheap callback (e.g. assign to a ref) — directories are
     *  enumerated at high rate; the CLI throttles spinner updates on top of
     *  this with a setInterval. */
    onDirEntered?: (dir: string) => void;
    /** Optional dir-meta cache. When provided, walkFiles statSyncs each dir
     *  and skips readdirSync when (dir_mtime_ns, ino) match the cached row,
     *  replaying the cached child list. APFS dir mtime bumps only on
     *  namespace changes (POSIX 1003.1-2001 §4.7), so unchanged
     *  (dir_mtime_ns, ino) means the immediate-child name list is unchanged.
     *  Per-file mtime/size changes are caught by the file-meta cache layer. */
    cache?: FileMetaCacheLike;
}

export interface DiskUsage {
    /** Sum of stat.size — logical content bytes. */
    logical: number;
    /** Sum of stat.blocks * 512 — per-inode allocated (du-style; overcounts clones). */
    allocated: number;
    /** Sum of getPrivateSize — bytes freed if this tree is deleted while the
     *  cache / other projects stay. null off-darwin or if every call failed. */
    private: number | null;
    /** private + each fully-in-tree clone family's shared bytes counted once
     *  (best-effort intra-tree dedup). null when private is null. */
    exactReclaimable: number | null;
    fileCount: number;
    /** Subdirectories under root, excluding root itself. Derived from the
     *  parent dirs of measured files — pure-empty subdirs (no files) are not
     *  counted (they contribute zero bytes, so this is acceptable here). */
    dirCount: number;
    errors: WalkError[];
}

const BLOCK_SIZE = 512;

export function fileLogicalSize(path: string): number {
    return statSync(path).size;
}

export function fileAllocatedSize(path: string): number {
    return Number(statSync(path, { bigint: true }).blocks) * BLOCK_SIZE;
}

/** Clone-aware reclaimable bytes for one file. null off-darwin / on error. */
export function filePrivateSize(path: string): number | null {
    return getPrivateSize(path);
}

/** Recursively yields regular files under `root`. Never follows symlinks
 *  (readdirSync does not, and apfs syscalls use FSOPT_NOFOLLOW). Per-entry
 *  errors (EPERM/ENOENT mid-walk) are reported via opts.onError, not thrown.
 *  Honours `opts.shouldEnter` for directory pruning and `opts.signal` for
 *  cancellation (checked once per directory). */
export function* walkFiles(root: string, opts: WalkOptions = {}): Generator<WalkEntry> {
    opts.signal?.throwIfAborted();

    // Dir-meta cache short-circuit (Phase 10). If the cache has a row for
    // this dir whose (dir_mtime_ns, ino) match the fresh stat, the
    // immediate-child name list is unchanged since the last scan (POSIX
    // 1003.1-2001 §4.7 — namespace changes are the only mtime triggers).
    // We replay the cached child list and skip readdirSync entirely.
    let dirStat: ReturnType<typeof statSync> | null = null;
    if (opts.cache?.getDir !== undefined) {
        try {
            dirStat = statSync(root, { bigint: true });
        } catch {
            // ignore — readdirSync below will surface the real error
        }
    }

    const cachedDir = opts.cache?.getDir !== undefined && dirStat !== null ? opts.cache.getDir(root) : null;
    if (
        cachedDir !== null &&
        cachedDir !== undefined &&
        dirStat !== null &&
        cachedDir.dirMtimeNs === (dirStat as { mtimeNs: bigint }).mtimeNs &&
        cachedDir.ino === (dirStat as { ino: bigint }).ino
    ) {
        opts.onDirEntered?.(root);
        for (const child of cachedDir.childNames) {
            const p = join(root, child.name);
            if (child.kind === "symlink") {
                continue;
            }
            if (child.kind === "dir") {
                if (opts.shouldEnter && !opts.shouldEnter(p)) {
                    continue;
                }
                yield* walkFiles(p, opts);
            } else {
                try {
                    const st = statSync(p, { bigint: true });
                    yield {
                        path: p,
                        logical: Number(st.size),
                        allocated: Number(st.blocks) * BLOCK_SIZE,
                        mtimeNs: st.mtimeNs,
                    };
                } catch (err) {
                    opts.onError?.({ path: p, errno: errnoOf(err) });
                }
            }
        }
        return;
    }

    // P1 — `getattrlistbulk(2)` fast path. One syscall per dir returns
    // (name, kind, size, allocSize, mtime, fileid, cloneId) for every entry,
    // replacing `readdirSync + N × statSync + N × getattrlist(CLONEID)`.
    // Fall back to readdirSync + statSync per-dir on `ENOTSUP` (non-APFS
    // volume inside the scan root) or any other libc error.
    if (BULK_AVAILABLE) {
        try {
            const bulkChildren: Array<{ name: string; kind: "file" | "dir" | "symlink" }> = [];
            const fileEntries: Array<{
                path: string;
                size: bigint;
                allocSize: bigint;
                mtimeNs: bigint;
                cloneId: bigint;
            }> = [];
            const subdirs: string[] = [];
            for (const e of iterDir(root)) {
                if (e.errorCode !== 0) {
                    opts.onError?.({ path: join(root, e.name), errno: `errno=${e.errorCode}` });
                    continue;
                }

                if (e.kind === "LNK") {
                    bulkChildren.push({ name: e.name, kind: "symlink" });
                    continue;
                }

                if (e.kind === "DIR") {
                    bulkChildren.push({ name: e.name, kind: "dir" });
                    subdirs.push(join(root, e.name));
                    continue;
                }

                if (e.kind === "REG") {
                    bulkChildren.push({ name: e.name, kind: "file" });
                    fileEntries.push({
                        path: join(root, e.name),
                        size: e.size,
                        allocSize: e.allocSize,
                        mtimeNs: e.mtimeNs,
                        cloneId: e.cloneId,
                    });
                }
                // OTHER (sockets, fifos, …): skip silently
            }

            opts.onDirEntered?.(root);

            // Populate dir-meta cache from bulk result so warm reruns hit
            // the Phase-10 short-circuit above without re-running bulk.
            if (opts.cache?.setDir !== undefined && dirStat !== null) {
                opts.cache.setDir(root, {
                    dirMtimeNs: (dirStat as { mtimeNs: bigint }).mtimeNs,
                    ino: (dirStat as { ino: bigint }).ino,
                    childNames: bulkChildren,
                    lastSeenAt: 0,
                });
            }

            for (const fe of fileEntries) {
                yield {
                    path: fe.path,
                    logical: Number(fe.size),
                    allocated: Number(fe.allocSize),
                    mtimeNs: fe.mtimeNs,
                    cloneIdHex: fe.cloneId === 0n ? "" : fe.cloneId.toString(16),
                };
            }
            for (const subPath of subdirs) {
                if (opts.shouldEnter && !opts.shouldEnter(subPath)) {
                    continue;
                }

                yield* walkFiles(subPath, opts);
            }
            return;
        } catch (err) {
            if (err instanceof GetattrlistbulkUnsupportedError) {
                logger.debug({ root }, "walkFiles: ENOTSUP, falling back to readdir+stat");
                // fall through to readdir path below
            } else {
                // `open(dir)` failed (ENOENT, EACCES, ENOTDIR…) — surface as a
                // walk error, same shape readdir would have produced.
                opts.onError?.({ path: root, errno: errnoOf(err) });
                return;
            }
        }
    }

    let entries: Dirent[];
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
        opts.onError?.({ path: root, errno: errnoOf(err) });
        return;
    }

    opts.onDirEntered?.(root);

    // Populate the dir cache for next scan.
    if (opts.cache?.setDir !== undefined && dirStat !== null) {
        const childNames: Array<{ name: string; kind: "file" | "dir" | "symlink" }> = [];
        for (const e of entries) {
            const kind: "file" | "dir" | "symlink" = e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "dir" : "file";
            childNames.push({ name: e.name, kind });
        }
        opts.cache.setDir(root, {
            dirMtimeNs: (dirStat as { mtimeNs: bigint }).mtimeNs,
            ino: (dirStat as { ino: bigint }).ino,
            childNames,
            lastSeenAt: 0,
        });
    }

    for (const entry of entries) {
        const p = join(root, entry.name);
        if (entry.isSymbolicLink()) {
            continue;
        }

        if (entry.isDirectory()) {
            if (opts.shouldEnter && !opts.shouldEnter(p)) {
                continue;
            }

            yield* walkFiles(p, opts);
        } else if (entry.isFile()) {
            try {
                const st = statSync(p, { bigint: true });
                yield {
                    path: p,
                    logical: Number(st.size),
                    allocated: Number(st.blocks) * BLOCK_SIZE,
                    mtimeNs: st.mtimeNs,
                };
            } catch (err) {
                opts.onError?.({ path: p, errno: errnoOf(err) });
            }
        }
    }
}

function errnoOf(err: unknown): string {
    if (err && typeof err === "object" && "code" in err) {
        return String((err as { code: unknown }).code);
    }

    return "UNKNOWN";
}

export interface MeasureOptions {
    /** Include clone-family dedup pass for exactReclaimable. Default true. */
    exact?: boolean;
}

export function measureTree(root: string, opts: MeasureOptions = {}): DiskUsage {
    const errors: WalkError[] = [];
    let logical = 0;
    let allocated = 0;
    let privateSum = 0;
    let privateSeen = false;
    let fileCount = 0;
    const dirs = new Set<string>();
    const cloneGroups = new Map<string, { private: number; allocated: number }>();
    const rootKey = root.endsWith("/") ? root.slice(0, -1) : root;

    for (const e of walkFiles(root, { onError: (err) => errors.push(err) })) {
        fileCount += 1;
        logical += e.logical;
        allocated += e.allocated;
        const parent = e.path.slice(0, e.path.lastIndexOf("/"));
        if (parent !== rootKey) {
            dirs.add(parent);
        }

        const priv = getPrivateSize(e.path);
        if (priv !== null) {
            privateSeen = true;
            privateSum += priv;
            if (opts.exact !== false) {
                const id = getCloneId(e.path);
                if (id !== null && id !== 0n) {
                    const key = id.toString(16);
                    const g = cloneGroups.get(key) ?? { private: 0, allocated: 0 };
                    g.private += priv;
                    g.allocated += e.allocated;
                    cloneGroups.set(key, g);
                }
            }
        }
    }

    const privateTotal = privateSeen ? privateSum : null;
    let exactReclaimable: number | null = privateTotal;
    if (privateTotal !== null && opts.exact !== false) {
        let sharedOnce = 0;
        for (const g of cloneGroups.values()) {
            // bytes shared by an in-tree clone family, counted a single time
            sharedOnce += Math.max(0, g.allocated - g.private);
        }

        exactReclaimable = privateTotal + sharedOnce;
    }

    return {
        logical,
        allocated,
        private: privateTotal,
        exactReclaimable,
        fileCount,
        dirCount: dirs.size,
        errors,
    };
}

/** Bytes freed if `root` is deleted while the bun cache / other projects stay
 *  (the real-world question). Correct for the common cross-tree case
 *  (node_modules ↔ cache). For the rarer case of two files cloned to each
 *  other *inside* `root`, this UNDERCOUNTS — use exactReclaimableBytes. */
export function reclaimableBytes(root: string): number | null {
    return measureTree(root, { exact: false }).private;
}

/** Best-effort whole-tree reclaim: reclaimableBytes plus each in-tree clone
 *  family's shared bytes counted once. Approximate (exact extent accounting
 *  via F_LOG2PHYS_EXT is a non-goal). null off-darwin. */
export function exactReclaimableBytes(root: string): number | null {
    return measureTree(root, { exact: true }).exactReclaimable;
}

/** Maps clone-id (hex) → file paths that share it, for files under `root`.
 *  Empty off-darwin / when no clones present. */
export function findCloneFamilies(root: string): Map<string, string[]> {
    const families = new Map<string, string[]>();
    for (const e of walkFiles(root)) {
        const id = getCloneId(e.path);
        if (id === null || id === 0n) {
            continue;
        }

        const key = id.toString(16);
        const list = families.get(key) ?? [];
        list.push(e.path);
        families.set(key, list);
    }

    for (const [key, list] of families) {
        if (list.length < 2) {
            families.delete(key);
        }
    }

    return families;
}

export interface FreeSpace {
    total: number;
    free: number;
    available: number;
}

/** Volume capacity for the filesystem containing `path` (node:fs.statfsSync,
 *  works in Bun 1.3.13). Cross-platform. */
export function freeDiskSpace(path: string): FreeSpace {
    const s = statfsSync(path, { bigint: true });
    const bsize = Number(s.bsize);
    return {
        total: Number(s.blocks) * bsize,
        free: Number(s.bfree) * bsize,
        available: Number(s.bavail) * bsize,
    };
}

/** How inflated the du/allocated number is vs the real reclaimable size.
 *  null when private is unavailable (non-darwin / all syscalls failed). */
export function overcountRatio(root: string): { allocated: number; private: number; ratio: number } | null {
    const u = measureTree(root);
    if (u.private === null) {
        return null;
    }

    const ratio = u.private > 0 ? u.allocated / u.private : 1;
    return { allocated: u.allocated, private: u.private, ratio };
}

/** Multi-line human summary that always shows du vs real side-by-side. */
export function formatDiskUsage(u: DiskUsage): string {
    const lines = [
        `files: ${u.fileCount}  dirs: ${u.dirCount}`,
        `logical:   ${formatBytes(u.logical)}`,
        `du says:   ${formatBytes(u.allocated)}  (per-inode, overcounts clones)`,
    ];
    if (u.private === null) {
        lines.push("actually:  unknown (clone-aware sizing unavailable here)");
    } else {
        const ratio = u.private > 0 ? u.allocated / u.private : 1;
        lines.push(`actually:  ${formatBytes(u.private)} freed if deleted now` + `  (overcount ${ratio.toFixed(1)}x)`);
        if (u.exactReclaimable !== null && u.exactReclaimable !== u.private) {
            lines.push(`whole-tree: ~${formatBytes(u.exactReclaimable)} (clone-deduped)`);
        }
    }

    if (u.errors.length > 0) {
        lines.push(`(${u.errors.length} path(s) skipped: ${u.errors[0].errno}…)`);
    }

    return lines.join("\n");
}

export interface DuplicateGroup {
    /** Byte length shared by every file in the group. */
    size: number;
    sha256: string;
    paths: string[];
}

export interface DedupeCandidate {
    sha256: string;
    size: number;
    /** Representative kept as-is (the others are re-cloned from it). */
    keep: string;
    /** Files to replace with a clone of `keep` (excludes ones already
     *  sharing keep's clone id). */
    replace: string[];
    /** Bytes reclaimed if every `replace` becomes a clone of `keep`. */
    reclaimable: number;
}

/** Chunk size for streaming I/O. 64 KB balances syscall overhead against
 *  memory: enough to amortize read() costs, small enough to never OOM on
 *  multi-GB files. */
const STREAM_CHUNK_BYTES = 64 * 1024;

/** Streaming SHA-256 — reads `path` in chunks instead of slurping the whole
 *  file into memory. Required for safety: a `node_modules` tree may contain
 *  arbitrarily-large bundles, source maps, or media that would OOM under
 *  `readFileSync`. Exported so callers (e.g. the audit log) can share one
 *  implementation. `signal` is checked between chunks so Ctrl+C can break
 *  out of a multi-GB read within one 64 KB chunk. */
export function sha256File(path: string, opts: { signal?: AbortSignal } = {}): string {
    const h = createHash("sha256");
    const fd = openSync(path, "r");
    try {
        const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        for (;;) {
            opts.signal?.throwIfAborted();
            const n = readSync(fd, buf, 0, buf.length, null);
            if (n <= 0) {
                break;
            }

            h.update(buf.subarray(0, n));
        }
    } finally {
        closeSync(fd);
    }

    return h.digest("hex");
}

/** Streaming, INDEPENDENT-inode byte copy. Unlike `fs.copyFileSync` (which
 *  may use `clonefile` on APFS and preserve the clone family), this performs
 *  an explicit user-space read/write loop so the destination is GUARANTEED
 *  to be a fresh inode with its own physical extents. Required for rollback:
 *  the whole point of un-cloning is to produce an independent copy. */
export function copyFileStreaming(src: string, dst: string): void {
    const srcFd = openSync(src, "r");
    let dstFd: number | null = null;
    try {
        // 'wx' = create-exclusive — fail if dst already exists. Callers route
        // to a temp path then renameSync, so existence at dst is an error.
        dstFd = openSync(dst, "wx");
        const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        for (;;) {
            const n = readSync(srcFd, buf, 0, buf.length, null);
            if (n <= 0) {
                break;
            }

            let written = 0;
            while (written < n) {
                written += writeSync(dstFd, buf, written, n - written);
            }
        }
    } finally {
        closeSync(srcFd);
        if (dstFd !== null) {
            closeSync(dstFd);
        }
    }
}

/** Streaming byte-equality. Reads both files in lockstep 64 KB chunks and
 *  compares each chunk. Used by `dedupeFile` (Safety Contract invariant 1)
 *  and `findDuplicateFiles` to confirm sha-matched files are truly equal
 *  without ever materializing the full content. `signal` is checked between
 *  chunks so Ctrl+C breaks out within one 64 KB read pair. */
export function bytesEqualStreaming(a: string, b: string, opts: { signal?: AbortSignal } = {}): boolean {
    const fdA = openSync(a, "r");
    let fdB: number | null = null;
    try {
        fdB = openSync(b, "r");
        const bufA = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        const bufB = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        while (true) {
            opts.signal?.throwIfAborted();
            const nA = readSync(fdA, bufA, 0, bufA.length, null);
            const nB = readSync(fdB, bufB, 0, bufB.length, null);
            if (nA !== nB) {
                return false;
            }

            if (nA === 0) {
                return true;
            }

            if (!bufA.subarray(0, nA).equals(bufB.subarray(0, nB))) {
                return false;
            }
        }
    } finally {
        closeSync(fdA);
        if (fdB !== null) {
            closeSync(fdB);
        }
    }
}

export interface FindDuplicatesStats {
    /** Files yielded by walkFiles (pre-minSize filter). */
    walkedFiles: number;
    /** Directories entered (callback fires after a successful readdirSync). */
    walkedDirs: number;
    /** Wall-clock ms spent in the walk phase. */
    walkMs: number;
    /** Distinct file-size buckets (post-minSize). */
    bucketsTotal: number;
    /** Buckets dropped because all members share one APFS clone-family (reclaim=0). */
    bucketsDroppedByClone: number;
    /** Buckets where at least one rep got hashed. */
    bucketsHashed: number;
    /** `getCloneId` syscall count. */
    cloneIdCalls: number;
    /** `sha256File` call count (one per rep). */
    sha256Calls: number;
    /** Logical bytes hashed (sum of sizes for hashed reps). */
    sha256Bytes: number;
    /** `bytesEqualStreaming` call count (sha tiebreaker). */
    byteCompareCalls: number;
    /** Wall-clock ms spent in the hash + byte-compare phase. */
    hashMs: number;
    /** Per-file cache hits (size+mtime_ns match → sha+cloneId reused). Wired in Phase 3. */
    cacheHits: number;
    /** Per-file cache misses (new file or size/mtime changed → recomputed). Wired in Phase 3. */
    cacheMisses: number;
}

export function emptyFindDuplicatesStats(): FindDuplicatesStats {
    return {
        walkedFiles: 0,
        walkedDirs: 0,
        walkMs: 0,
        bucketsTotal: 0,
        bucketsDroppedByClone: 0,
        bucketsHashed: 0,
        cloneIdCalls: 0,
        sha256Calls: 0,
        sha256Bytes: 0,
        byteCompareCalls: 0,
        hashMs: 0,
        cacheHits: 0,
        cacheMisses: 0,
    };
}

/** Minimal duck-type for the FileMetaCache so utils/fs/ doesn't depend on
 *  macos/lib/clones/. The real implementation lives in
 *  `src/macos/lib/clones/file-meta-cache.ts` and is structurally compatible. */
export interface FileMetaCacheLike {
    get(path: string): {
        size: bigint;
        mtimeNs: bigint;
        sha256: string;
        cloneId: string;
        lastSeenAt: number;
    } | null;
    set(
        path: string,
        entry: {
            size: bigint;
            mtimeNs: bigint;
            sha256: string;
            cloneId: string;
            lastSeenAt: number;
        }
    ): void;
    /** Optional dir-meta API (Phase 10). Absent on older test fakes — walk
     *  falls through to unconditional readdirSync when missing. */
    getDir?(path: string): {
        dirMtimeNs: bigint;
        ino: bigint;
        childNames: Array<{ name: string; kind: "file" | "dir" | "symlink" }>;
        lastSeenAt: number;
    } | null;
    setDir?(
        path: string,
        entry: {
            dirMtimeNs: bigint;
            ino: bigint;
            childNames: Array<{ name: string; kind: "file" | "dir" | "symlink" }>;
            lastSeenAt: number;
        }
    ): void;
}

export interface FindDuplicatesOptions {
    /** Ignore files whose logical size is below this. Pruned during the walk. */
    minSize?: number;
    /** Aborts the walk + hash + byte-compare between syscalls. */
    signal?: AbortSignal;
    /** Directory predicate forwarded to `walkFiles`. Returning false skips
     *  the subtree entirely (no `stat` cost on its contents). */
    shouldEnter?: (dir: string) => boolean;
    /** Forwarded to `walkFiles` — called per directory entered. CLI uses
     *  this to drive a live spinner. */
    onDirEntered?: (dir: string) => void;
    /** Optional out-param: this function adds-to (does NOT reset) these counters
     *  so a caller scanning N roots in sequence gets aggregate totals. */
    stats?: FindDuplicatesStats;
    /** Per-file metadata cache. When provided, the hash phase reuses
     *  (sha256, cloneId) for any file whose (size, mtimeNs) matches the
     *  cached entry. Missing/changed files re-hash and write back. */
    cache?: FileMetaCacheLike;
}

/** How often we yield to the event loop during the size-bucket loop.
 *  Async-needed so SIGINT handlers can run — pure sync code in Node/Bun
 *  starves the event loop and the user's Ctrl+C never gets delivered. */
const YIELD_EVERY_BUCKETS = 64;

/** How often we yield to the event loop while consuming `walkFiles` —
 *  for 100+GB trees the walk dominates and without this SIGINT can't be
 *  delivered until the entire walk finishes. 1024 entries is roughly
 *  10ms of stat work between yields. */
const YIELD_EVERY_WALK_ENTRIES = 1024;

function yieldToLoop(): Promise<void> {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}

/** Content-identical regular files under `root`, grouped (size → clone-id
 *  → sha256 → full byte-compare). Groups of <2 are dropped. Order-independent.
 *
 *  **Async because Ctrl+C must work.** Sync JS code (a tight loop of
 *  `getCloneId` syscalls + `sha256File` reads) starves the event loop, so
 *  the SIGINT handler that flips `signal.aborted` never runs until the
 *  whole walk is done. We yield via `setImmediate` every
 *  `YIELD_EVERY_BUCKETS` size-buckets and check `signal.throwIfAborted()`
 *  on each yield, so abort latency is bounded by (yield interval × bucket
 *  cost) — typically well under one second.
 *
 *  **The contract: each returned group's `paths` is exactly one
 *  representative per APFS clone-family.** Files inside the same clone
 *  family share their physical extents — they're not duplicates from a
 *  reclaim perspective and are NOT included individually in the group
 *  (otherwise `reclaimable = (paths.length - 1) * size` overcounts the
 *  cloned members at zero-actual-reclaim). To recover the full set of
 *  paths backing a group's content, the caller can walk the file system
 *  separately; for dedupe purposes only reps matter. Same-size groups
 *  whose members all collapse to one clone family are dropped entirely.
 *
 *  `minSize` is applied during the walk so large trees don't materialise
 *  paths for every below-threshold file. */
/** Emit a heartbeat log every N walk entries / N hash buckets. Count-based,
 *  not time-based — integers don't drift and don't need wall-clock checks per
 *  iteration. For a 148GB scan with hundreds of thousands of files and a few
 *  thousand buckets, these give ~5-10 lines per phase: sparse enough to read,
 *  dense enough to confirm the scan is moving when tailed via `Monitor`. */
const WALK_HEARTBEAT_EVERY = 50_000;
const HASH_HEARTBEAT_EVERY = 1_000;

export async function findDuplicateFiles(root: string, opts: FindDuplicatesOptions = {}): Promise<DuplicateGroup[]> {
    const minSize = Math.max(1, opts.minSize ?? 1);
    const { signal, shouldEnter, onDirEntered, stats, cache } = opts;

    const sw = new Stopwatch();
    let phaseStartMs = sw.elapsedMs;

    logger.info(
        { event: "findDuplicateFiles.start", root, minSize, cacheAttached: cache !== undefined },
        "findDuplicateFiles start"
    );

    let walkedFiles = 0;
    let walkedDirs = 0;
    let lastDir = "";

    const bySize = new Map<number, string[]>();
    // Parallel side-map so the value type of `bySize` stays `string[]` and the
    // existing destructuring throughout the hash loop is unchanged. Populated
    // during the walk (bigint mtimeNs comes from the already-bigint statSync
    // in walkFiles — no extra syscall).
    const mtimeByPath = new Map<string, bigint>();
    // P1 — when walkFiles used the `getattrlistbulk` fast path, every WalkEntry
    // carries `cloneIdHex` inline (one syscall per dir vs one getattrlist per
    // file). Empty string = file has no clone family. Undefined = walker
    // didn't fetch it (cache-hit replay, non-darwin, ENOTSUP). The hash phase
    // prefers walk-supplied cloneIdHex over the per-file `getCloneId` syscall.
    const walkCloneIdByPath = new Map<string, string>();
    const walkOpts: WalkOptions = {};
    if (signal !== undefined) {
        walkOpts.signal = signal;
    }
    if (shouldEnter !== undefined) {
        walkOpts.shouldEnter = shouldEnter;
    }
    // Wrap caller's onDirEntered so we can count dirs walked even with no caller hook.
    const userDirEntered = onDirEntered;
    walkOpts.onDirEntered = (dir) => {
        walkedDirs += 1;
        lastDir = dir;
        userDirEntered?.(dir);
    };
    if (cache !== undefined) {
        walkOpts.cache = cache;
    }
    let walkCount = 0;
    for (const e of walkFiles(root, walkOpts)) {
        if ((walkCount++ & (YIELD_EVERY_WALK_ENTRIES - 1)) === 0) {
            await yieldToLoop();
            signal?.throwIfAborted();
        }

        walkedFiles += 1;
        if (walkedFiles % WALK_HEARTBEAT_EVERY === 0) {
            logger.info(
                {
                    event: "walk.progress",
                    root,
                    files: walkedFiles,
                    dirs: walkedDirs,
                    elapsedMs: Math.round(sw.elapsedMs - phaseStartMs),
                    currentDir: lastDir,
                },
                "walk progress"
            );
        }

        if (e.logical < minSize) {
            continue;
        }

        const list = bySize.get(e.logical) ?? [];
        list.push(e.path);
        bySize.set(e.logical, list);
        mtimeByPath.set(e.path, e.mtimeNs);
        if (e.cloneIdHex !== undefined) {
            walkCloneIdByPath.set(e.path, e.cloneIdHex);
        }
    }

    const walkMs = sw.elapsedMs - phaseStartMs;
    logger.info(
        {
            event: "walk.complete",
            root,
            files: walkedFiles,
            dirs: walkedDirs,
            buckets: bySize.size,
            walkMs: Math.round(walkMs),
        },
        "walk complete"
    );
    phaseStartMs = sw.elapsedMs;

    let cloneIdCalls = 0;
    let sha256Calls = 0;
    let sha256Bytes = 0;
    let byteCompareCalls = 0;
    let bucketsDroppedByClone = 0;
    let bucketsHashed = 0;
    let cacheHits = 0;
    let cacheMisses = 0;

    const groups: DuplicateGroup[] = [];
    let bucketIndex = 0;
    for (const [size, paths] of bySize) {
        if ((bucketIndex & (YIELD_EVERY_BUCKETS - 1)) === 0) {
            await yieldToLoop();
        }
        bucketIndex += 1;
        signal?.throwIfAborted();

        if (bucketIndex % HASH_HEARTBEAT_EVERY === 0) {
            logger.info(
                {
                    event: "hash.progress",
                    root,
                    bucketsTotal: bySize.size,
                    bucketsSeen: bucketIndex,
                    bucketsHashed,
                    bucketsDroppedByClone,
                    sha256Calls,
                    sha256BytesMB: Math.round(sha256Bytes / 1e6),
                    cacheHits,
                    cacheMisses,
                    elapsedMs: Math.round(sw.elapsedMs - phaseStartMs),
                },
                "hash progress"
            );
        }

        if (paths.length < 2) {
            continue;
        }

        // Clone-family pre-filter. Key = "id:<hex>" for real clone families,
        // "solo:<idx>" for files without a clone-id (each treated as its own
        // singleton family so they all get hashed).
        //
        // Cache short-circuit: if the file-meta cache has a row for this path
        // with matching (size, mtimeNs), the cached cloneId is authoritative
        // — (size, mtime) unchanged means inode unchanged means clone_id
        // unchanged. Saves one getattrlist syscall per file per bucket.
        const byClone = new Map<string, string[]>();
        const cloneIdByPath = new Map<string, string>();
        for (let i = 0; i < paths.length; i++) {
            const p = paths[i];
            const mtimeNs = mtimeByPath.get(p);
            const hit = cache?.get(p);
            const walked = walkCloneIdByPath.get(p);
            let cloneIdHex: string;
            // Three sources, in priority order:
            //  1. Walk-supplied cloneIdHex (set by the P1 bulk path — current,
            //     no extra syscall). Empty string is a valid "no clone family"
            //     answer — distinct from undefined ("walker didn't fetch").
            //  2. File-meta cache when (size, mtimeNs) match (saves a syscall
            //     on warm reruns where the walk took the dir-cache replay
            //     path and so didn't fill cloneIdHex).
            //  3. Per-file `getCloneId(path)` syscall fallback.
            if (walked !== undefined) {
                cloneIdHex = walked;
            } else if (hit && mtimeNs !== undefined && hit.size === BigInt(size) && hit.mtimeNs === mtimeNs) {
                cloneIdHex = hit.cloneId;
            } else {
                cloneIdCalls += 1;
                const id = getCloneId(p);
                cloneIdHex = id !== null && id !== 0n ? id.toString(16) : "";
            }
            cloneIdByPath.set(p, cloneIdHex);
            const key = cloneIdHex !== "" ? `id:${cloneIdHex}` : `solo:${i}`;
            const arr = byClone.get(key);
            if (arr) {
                arr.push(p);
            } else {
                byClone.set(key, [p]);
            }
        }

        // Reps = one path per clone-family. If <2 reps remain, every file in
        // this size bucket is already part of a single clone family — nothing
        // reclaimable, skip the whole bucket without hashing.
        if (byClone.size < 2) {
            bucketsDroppedByClone += 1;
            continue;
        }

        bucketsHashed += 1;

        const reps: string[] = [];
        for (const family of byClone.values()) {
            reps.push(family[0]);
        }

        const byHash = new Map<string, string[]>();
        for (const p of reps) {
            const mtimeNs = mtimeByPath.get(p);
            const hit = cache?.get(p);
            let h: string;
            // Cache hit only if size AND mtimeNs both match. Both are bigint
            // (cache uses safeIntegers; walk returns bigint mtimeNs). size in
            // bySize is `number` so we promote to bigint for the compare.
            // If mtimeNs is undefined (shouldn't happen — every walked path
            // is in the side-map) we conservatively force a miss.
            if (hit && mtimeNs !== undefined && hit.size === BigInt(size) && hit.mtimeNs === mtimeNs) {
                cacheHits += 1;
                h = hit.sha256;
            } else {
                cacheMisses += 1;
                sha256Calls += 1;
                sha256Bytes += size;
                h = sha256File(p, signal !== undefined ? { signal } : {});
                if (cache && mtimeNs !== undefined) {
                    cache.set(p, {
                        size: BigInt(size),
                        mtimeNs,
                        sha256: h,
                        cloneId: cloneIdByPath.get(p) ?? "",
                        lastSeenAt: 0,
                    });
                }
            }
            const list = byHash.get(h) ?? [];
            list.push(p);
            byHash.set(h, list);
        }

        for (const [sha256, group] of byHash) {
            if (group.length < 2) {
                continue;
            }

            // Streaming byte-equality against group[0] — sha collisions are
            // astronomical but Safety Contract invariant 1 requires actual
            // byte-equality, not just sha-equality, before cloning.
            //
            // DETECTION-side cache shortcut (Phase 9): if both sides have a
            // cache row whose (size, mtimeNs) matches the freshly-walked
            // values, last-scan's byte-compare result still applies — we
            // already proved byte-equality with then-fresh stats, and
            // unchanged (size, mtime) means unchanged contents. Skip the
            // re-read.
            //
            // SAFETY: This delegates collision risk to the Safety Contract
            // in `dedupeFile` (~disk-usage.ts:921), which UNCONDITIONALLY
            // calls bytesEqualStreaming(keep, replace) before each
            // `clonefile`. A SHA-256 collision that survived through
            // detection here would land on the user's confirmation prompt,
            // then be re-byte-compared at apply time and emit
            // `skipped-different`. Net effect of a phantom dup: wasted user
            // attention, never a wrong dedupe. DO NOT remove this comment.
            const bytesOpts = signal !== undefined ? { signal } : {};
            const refPath = group[0];
            const refMtime = mtimeByPath.get(refPath);
            const refHit = cache?.get(refPath);
            const refCacheConfirmed =
                refHit !== null &&
                refHit !== undefined &&
                refMtime !== undefined &&
                refHit.size === BigInt(size) &&
                refHit.mtimeNs === refMtime;
            const confirmed = group.filter((p) => {
                if (p === refPath) {
                    return true;
                }
                if (refCacheConfirmed) {
                    const pMtime = mtimeByPath.get(p);
                    const pHit = cache?.get(p);
                    if (
                        pHit !== null &&
                        pHit !== undefined &&
                        pMtime !== undefined &&
                        pHit.size === BigInt(size) &&
                        pHit.mtimeNs === pMtime
                    ) {
                        // Both sides cache-confirmed; bytes proven equal in
                        // a prior scan that survived its own byte-compare.
                        // sha agreement is structurally guaranteed (every p
                        // in `group` has sha == refPath's sha, whether
                        // cached or freshly computed).
                        return true;
                    }
                }
                byteCompareCalls += 1;
                return bytesEqualStreaming(refPath, p, bytesOpts);
            });
            if (confirmed.length >= 2) {
                // Per the contract above: paths are exactly the confirmed
                // reps (one per clone-family). We do NOT expand back to the
                // full family — that would let the reclaim math overcount
                // by counting the cloned members at zero-actual-reclaim.
                groups.push({ size, sha256, paths: [...confirmed].sort() });
            }
        }
    }

    const hashMs = sw.elapsedMs - phaseStartMs;

    if (stats) {
        stats.walkedFiles += walkedFiles;
        stats.walkedDirs += walkedDirs;
        stats.walkMs += walkMs;
        stats.bucketsTotal += bySize.size;
        stats.bucketsHashed += bucketsHashed;
        stats.bucketsDroppedByClone += bucketsDroppedByClone;
        stats.cloneIdCalls += cloneIdCalls;
        stats.sha256Calls += sha256Calls;
        stats.sha256Bytes += sha256Bytes;
        stats.byteCompareCalls += byteCompareCalls;
        stats.hashMs += hashMs;
        stats.cacheHits += cacheHits;
        stats.cacheMisses += cacheMisses;
    }

    logger.info(
        {
            event: "findDuplicateFiles.complete",
            root,
            walkedFiles,
            walkedDirs,
            walkMs: Math.round(walkMs),
            bucketsTotal: bySize.size,
            bucketsDroppedByClone,
            bucketsHashed,
            cloneIdCalls,
            sha256Calls,
            sha256Bytes,
            byteCompareCalls,
            hashMs: Math.round(hashMs),
            cacheHits,
            cacheMisses,
            groupsEmitted: groups.length,
        },
        "findDuplicateFiles complete"
    );

    return groups;
}

/** Duplicate groups reduced to actionable dedupe work: pick a `keep`
 *  representative, list the `replace` files not already sharing its clone
 *  id, and project reclaimable bytes. Empty when nothing to do. */
export async function findDedupeCandidates(root: string, opts: FindDuplicatesOptions = {}): Promise<DedupeCandidate[]> {
    const out: DedupeCandidate[] = [];
    for (const g of await findDuplicateFiles(root, opts)) {
        const keep = g.paths[0];
        const keepId = getCloneId(keep);
        const replace = g.paths.slice(1).filter((p) => {
            const id = getCloneId(p);
            return !(keepId !== null && keepId !== 0n && id === keepId);
        });
        if (replace.length === 0) {
            continue;
        }

        out.push({
            sha256: g.sha256,
            size: g.size,
            keep,
            replace,
            reclaimable: replace.length * g.size,
        });
    }

    return out;
}

export type DedupeStatus =
    | "cloned"
    | "already-cloned"
    | "skipped-different"
    | "skipped-symlink"
    | "skipped-same-file"
    | "skipped-not-regular";

export interface DedupeResult {
    status: DedupeStatus;
    bytesReclaimed: number;
}

export interface DedupeFileArgs {
    keep: string;
    replace: string;
}

function assertCloneSupported(keep: string, replace: string): void {
    const a = statSync(keep);
    const b = statSync(replace);
    if (a.dev !== b.dev) {
        throw new CloneUnsupportedError(`keep and replace are on different volumes (dev ${a.dev} != ${b.dev})`);
    }

    const fsType = getFsType(replace);
    if (fsType !== "apfs") {
        throw new CloneUnsupportedError(`filesystem of "${replace}" is "${fsType}", not apfs — clonefile unsupported`);
    }
}

/** Replace `replace` with a verified COW clone of `keep`, atomically.
 *  Preconditions enforced (size+sha256+byte-equal, same volume, APFS).
 *  Throws CloneUnsupportedError on a non-APFS / cross-volume target.
 *  See "Dedupe Safety Contract". */
export function dedupeFile({ keep, replace }: DedupeFileArgs): DedupeResult {
    if (resolve(keep) === resolve(replace)) {
        return { status: "skipped-same-file", bytesReclaimed: 0 };
    }

    const ks = lstatSync(keep);
    const rs = lstatSync(replace);
    if (ks.isSymbolicLink() || rs.isSymbolicLink()) {
        return { status: "skipped-symlink", bytesReclaimed: 0 };
    }

    if (!ks.isFile() || !rs.isFile()) {
        return { status: "skipped-not-regular", bytesReclaimed: 0 };
    }

    // same dev+ino = same file or a hardlink set → cloning would break the
    // hardlink relationship; leave it untouched.
    if (ks.dev === rs.dev && ks.ino === rs.ino) {
        return { status: "skipped-same-file", bytesReclaimed: 0 };
    }

    if (rs.size === 0) {
        return { status: "skipped-not-regular", bytesReclaimed: 0 };
    }

    if (ks.size !== rs.size) {
        return { status: "skipped-different", bytesReclaimed: 0 };
    }

    const keepId = getCloneId(keep);
    const replaceId = getCloneId(replace);
    if (keepId !== null && keepId !== 0n && keepId === replaceId) {
        return { status: "already-cloned", bytesReclaimed: 0 };
    }

    // Streaming byte-compare instead of two full readFileSyncs. Safety
    // Contract invariant 1 requires byte-equality before cloning; streaming
    // preserves the guarantee without OOM on multi-GB files.
    if (!bytesEqualStreaming(keep, replace)) {
        return { status: "skipped-different", bytesReclaimed: 0 };
    }

    assertCloneSupported(keep, replace);

    const reclaimed = fileAllocatedSize(replace);
    const tmp = `${replace}.gtclone.${process.pid}.${Date.now()}`;
    try {
        cloneFile(keep, tmp); // same dir → same volume
        renameSync(tmp, replace); // atomic swap — from here, the file IS the clone
    } catch (err) {
        try {
            unlinkSync(tmp);
        } catch (cleanupErr) {
            logger.debug({ cleanupErr, tmp }, "dedupeFile: temp cleanup failed");
        }

        throw err;
    }

    // Safety Contract invariant 4: each metadata restore is fail-tolerant.
    // The atomic rename above already committed the clone-swap; partial
    // metadata is acceptable — content + POSIX bits are what matter.
    try {
        chmodSync(replace, rs.mode & 0o7777);
    } catch (err) {
        logger.warn({ err, replace }, "dedupeFile: chmod restore failed (tolerated)");
    }

    try {
        utimesSync(replace, rs.atime, rs.mtime);
    } catch (err) {
        logger.warn({ err, replace }, "dedupeFile: utimes restore failed (tolerated)");
    }

    try {
        chownSync(replace, rs.uid, rs.gid);
    } catch (err) {
        logger.warn({ err, replace }, "dedupeFile: chown restore failed (tolerated)");
    }

    return { status: "cloned", bytesReclaimed: reclaimed };
}

export interface DedupeTreeOptions {
    /** When false, actually clone. Default true (report only). */
    apply?: boolean;
}

export interface DedupeTreeReport {
    dryRun: boolean;
    candidateGroups: number;
    projectedReclaim: number;
    cloned: number;
    bytesReclaimed: number;
    errors: { path: string; message: string }[];
}

/** Walk `root`, find non-clone duplicates, and (only if `apply: true`)
 *  convert each duplicate into a verified COW clone of its group's
 *  representative. Default is a dry run that mutates nothing. */
export async function dedupeTree(root: string, opts: DedupeTreeOptions = {}): Promise<DedupeTreeReport> {
    const apply = opts.apply === true;
    const candidates = await findDedupeCandidates(root);
    const report: DedupeTreeReport = {
        dryRun: !apply,
        candidateGroups: candidates.length,
        projectedReclaim: candidates.reduce((s, c) => s + c.reclaimable, 0),
        cloned: 0,
        bytesReclaimed: 0,
        errors: [],
    };
    if (!apply) {
        return report;
    }

    for (const c of candidates) {
        for (const replace of c.replace) {
            try {
                const r = dedupeFile({ keep: c.keep, replace });
                if (r.status === "cloned") {
                    report.cloned += 1;
                    report.bytesReclaimed += r.bytesReclaimed;
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                report.errors.push({ path: replace, message });
            }
        }
    }

    return report;
}
