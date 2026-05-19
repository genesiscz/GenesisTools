import { readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatBytes } from "@app/utils/format";
import { getCloneId, getPrivateSize } from "@app/utils/macos/apfs";

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
    let entries: ReturnType<typeof readdirSync>;
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
