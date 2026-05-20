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

export interface WalkEntry {
    path: string;
    logical: number;
    allocated: number;
}

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

    let entries: Dirent[];
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
        opts.onError?.({ path: root, errno: errnoOf(err) });
        return;
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

export interface FindDuplicatesOptions {
    /** Ignore files whose logical size is below this. Pruned during the walk. */
    minSize?: number;
    /** Aborts the walk + hash + byte-compare between syscalls. */
    signal?: AbortSignal;
    /** Directory predicate forwarded to `walkFiles`. Returning false skips
     *  the subtree entirely (no `stat` cost on its contents). */
    shouldEnter?: (dir: string) => boolean;
}

/** How often we yield to the event loop during the size-bucket loop.
 *  Async-needed so SIGINT handlers can run — pure sync code in Node/Bun
 *  starves the event loop and the user's Ctrl+C never gets delivered. */
const YIELD_EVERY_BUCKETS = 64;

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
 *  **Clone-family pre-filter (huge speedup for bun-installed node_modules):**
 *  before hashing, same-size files are pre-bucketed by APFS clone-id. Files
 *  already sharing a non-zero clone-id are by construction byte-identical AND
 *  share their physical extents — re-cloning would reclaim zero bytes. So we
 *  pick ONE representative per clone-family, sha just the reps, then expand
 *  each matched rep back to its full family in the returned groups. Same-size
 *  groups that collapse to a single rep (everyone's already in one family)
 *  are dropped entirely.
 *
 *  `minSize` is applied during the walk so large trees don't materialise
 *  paths for every below-threshold file. */
export async function findDuplicateFiles(root: string, opts: FindDuplicatesOptions = {}): Promise<DuplicateGroup[]> {
    const minSize = Math.max(1, opts.minSize ?? 1);
    const { signal, shouldEnter } = opts;

    const bySize = new Map<number, string[]>();
    const walkOpts: WalkOptions = {};
    if (signal !== undefined) {
        walkOpts.signal = signal;
    }
    if (shouldEnter !== undefined) {
        walkOpts.shouldEnter = shouldEnter;
    }
    for (const e of walkFiles(root, walkOpts)) {
        if (e.logical < minSize) {
            continue;
        }

        const list = bySize.get(e.logical) ?? [];
        list.push(e.path);
        bySize.set(e.logical, list);
    }

    const groups: DuplicateGroup[] = [];
    let bucketIndex = 0;
    for (const [size, paths] of bySize) {
        if ((bucketIndex++ & (YIELD_EVERY_BUCKETS - 1)) === 0) {
            await yieldToLoop();
        }
        signal?.throwIfAborted();

        if (paths.length < 2) {
            continue;
        }

        // Clone-family pre-filter. Key = "id:<hex>" for real clone families,
        // "solo:<idx>" for files without a clone-id (each treated as its own
        // singleton family so they all get hashed).
        const byClone = new Map<string, string[]>();
        for (let i = 0; i < paths.length; i++) {
            const id = getCloneId(paths[i]);
            const key = id !== null && id !== 0n ? `id:${id.toString(16)}` : `solo:${i}`;
            const arr = byClone.get(key);
            if (arr) {
                arr.push(paths[i]);
            } else {
                byClone.set(key, [paths[i]]);
            }
        }

        // Reps = one path per clone-family. If <2 reps remain, every file in
        // this size bucket is already part of a single clone family — nothing
        // reclaimable, skip the whole bucket without hashing.
        if (byClone.size < 2) {
            continue;
        }

        const reps: string[] = [];
        const repToFamily = new Map<string, string[]>();
        for (const family of byClone.values()) {
            reps.push(family[0]);
            repToFamily.set(family[0], family);
        }

        const byHash = new Map<string, string[]>();
        for (const p of reps) {
            const h = sha256File(p, signal !== undefined ? { signal } : {});
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
            const bytesOpts = signal !== undefined ? { signal } : {};
            const confirmed = group.filter((p) => p === group[0] || bytesEqualStreaming(group[0], p, bytesOpts));
            if (confirmed.length >= 2) {
                // Expand reps back to their full clone-families.
                const all: string[] = [];
                for (const rep of confirmed) {
                    const fam = repToFamily.get(rep);
                    if (fam) {
                        all.push(...fam);
                    } else {
                        all.push(rep);
                    }
                }

                groups.push({ size, sha256, paths: all.sort() });
            }
        }
    }

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
