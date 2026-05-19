import { createHash } from "node:crypto";
import {
    type Dirent,
    chmodSync,
    lstatSync,
    readFileSync,
    readdirSync,
    renameSync,
    statfsSync,
    statSync,
    unlinkSync,
    utimesSync,
} from "node:fs";
import { join, resolve } from "node:path";
import logger from "@app/logger";
import { formatBytes } from "@app/utils/format";
import {
    CloneUnsupportedError,
    cloneFile,
    getCloneId,
    getFsType,
    getPrivateSize,
} from "@app/utils/macos/apfs";

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
 *  errors (EPERM/ENOENT mid-walk) are reported via opts.onError, not thrown. */
export function* walkFiles(
    root: string,
    opts: WalkOptions = {},
): Generator<WalkEntry> {
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

export function measureTree(
    root: string,
    opts: MeasureOptions = {},
): DiskUsage {
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
export function overcountRatio(
    root: string,
): { allocated: number; private: number; ratio: number } | null {
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
        lines.push(
            `actually:  ${formatBytes(u.private)} freed if deleted now` +
                `  (overcount ${ratio.toFixed(1)}x)`,
        );
        if (u.exactReclaimable !== null && u.exactReclaimable !== u.private) {
            lines.push(
                `whole-tree: ~${formatBytes(u.exactReclaimable)} (clone-deduped)`,
            );
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

function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Content-identical regular files under `root`, grouped (size → sha256 →
 *  full byte-compare). Groups of <2 are dropped. Order-independent. */
export function findDuplicateFiles(root: string): DuplicateGroup[] {
    const bySize = new Map<number, string[]>();
    for (const e of walkFiles(root)) {
        if (e.logical === 0) {
            continue;
        }

        const list = bySize.get(e.logical) ?? [];
        list.push(e.path);
        bySize.set(e.logical, list);
    }

    const groups: DuplicateGroup[] = [];
    for (const [size, paths] of bySize) {
        if (paths.length < 2) {
            continue;
        }

        const byHash = new Map<string, string[]>();
        for (const p of paths) {
            const h = sha256File(p);
            const list = byHash.get(h) ?? [];
            list.push(p);
            byHash.set(h, list);
        }

        for (const [sha256, group] of byHash) {
            if (group.length < 2) {
                continue;
            }

            const ref = readFileSync(group[0]);
            const confirmed = group.filter(
                (p) => p === group[0] || readFileSync(p).equals(ref),
            );
            if (confirmed.length >= 2) {
                groups.push({ size, sha256, paths: confirmed.sort() });
            }
        }
    }

    return groups;
}

/** Duplicate groups reduced to actionable dedupe work: pick a `keep`
 *  representative, list the `replace` files not already sharing its clone
 *  id, and project reclaimable bytes. Empty when nothing to do. */
export function findDedupeCandidates(root: string): DedupeCandidate[] {
    const out: DedupeCandidate[] = [];
    for (const g of findDuplicateFiles(root)) {
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
        throw new CloneUnsupportedError(
            `keep and replace are on different volumes (dev ${a.dev} != ${b.dev})`,
        );
    }

    const fsType = getFsType(replace);
    if (fsType !== "apfs") {
        throw new CloneUnsupportedError(
            `filesystem of "${replace}" is "${fsType}", not apfs — clonefile unsupported`,
        );
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

    const keepBuf = readFileSync(keep);
    if (!readFileSync(replace).equals(keepBuf)) {
        return { status: "skipped-different", bytesReclaimed: 0 };
    }

    assertCloneSupported(keep, replace);

    const reclaimed = fileAllocatedSize(replace);
    const tmp = `${replace}.gtclone.${process.pid}.${Date.now()}`;
    try {
        cloneFile(keep, tmp); // same dir → same volume
        // preserve replace's original identity-ish metadata
        renameSync(tmp, replace); // atomic swap
        chmodSync(replace, rs.mode & 0o7777);
        utimesSync(replace, rs.atime, rs.mtime);
    } catch (err) {
        try {
            unlinkSync(tmp);
        } catch (cleanupErr) {
            logger.debug({ cleanupErr, tmp }, "dedupeFile: temp cleanup failed");
        }

        throw err;
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
export function dedupeTree(
    root: string,
    opts: DedupeTreeOptions = {},
): DedupeTreeReport {
    const apply = opts.apply === true;
    const candidates = findDedupeCandidates(root);
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
