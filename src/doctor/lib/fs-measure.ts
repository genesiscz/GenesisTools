import { lstatSync, type Stats } from "node:fs";
import { filePrivateSize, resolvePrivateSize, type WalkError, walkFiles } from "@genesiscz/utils/fs/disk-usage";

const BLOCK_SIZE = 512;

export interface PathSize {
    kind: "file" | "dir" | "symlink" | "other";
    /** Blocks the volume holds for the path (`st_blocks * 512`, summed): the ceiling of what a delete frees. */
    allocatedBytes: number;
    /** Logical bytes (`st_size`, summed). A sparse VM disk is huge here and small in `allocatedBytes`. */
    apparentBytes: number;
    /** Conservative bytes a delete frees: APFS private bytes only. Shared extents may have owners outside the tree.
     *  Null where the volume cannot say (not APFS). */
    freeableFloorBytes: number | null;
    /** Files seen (1 for a file). */
    entries: number;
    /** Newest mtime of anything walked, in ms. A folder's own mtime moves only when its direct children change. */
    newestMtimeMs: number;
    /** False on traversal errors or a reached budget: every number is then a lower bound. */
    complete: boolean;
    errors: number;
}

export interface MeasureBudget {
    maxEntries?: number;
    deadlineMs?: number;
    /** Called for every file the walk sees, so a caller can look for markers (a worktree's `.git` file). */
    onFile?: (path: string) => void;
}

const DEFAULT_MAX_ENTRIES = 250_000;
const DEFAULT_DEADLINE_MS = 10_000;

export function isSparseOrCompressed(stat: Pick<Stats, "blocks" | "size">): boolean {
    const allocated = stat.blocks * BLOCK_SIZE;
    return stat.size >= 64 * 1024 * 1024 && allocated < stat.size / 2;
}

export function allocatedOf(stat: Pick<Stats, "blocks">): number {
    return stat.blocks * BLOCK_SIZE;
}

/**
 * Measure one path in-process: `lstat` for a file or link, one bounded `getattrlistbulk` walk for a folder.
 * Symlinks are never followed. Returns null when the path cannot be read.
 */
export function measurePath(path: string, budget: MeasureBudget = {}): PathSize | null {
    let stat: Stats;

    try {
        stat = lstatSync(path);
    } catch {
        return null;
    }

    if (stat.isSymbolicLink() || stat.isFile() || !stat.isDirectory()) {
        const allocated = allocatedOf(stat);
        const priv = stat.isFile() ? filePrivateSize(path) : null;

        return {
            kind: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other",
            allocatedBytes: allocated,
            apparentBytes: stat.size,
            freeableFloorBytes: priv,
            entries: 1,
            newestMtimeMs: stat.mtimeMs,
            complete: true,
            errors: 0,
        };
    }

    return measureDir(path, stat.mtimeMs, budget);
}

function measureDir(root: string, rootMtimeMs: number, budget: MeasureBudget): PathSize {
    const maxEntries = budget.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const deadline = Date.now() + (budget.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const errors: WalkError[] = [];

    let allocated = 0;
    let apparent = 0;
    let privateSum = 0;
    let privateSeen = false;
    let entries = 0;
    let newest = rootMtimeMs;
    let complete = true;

    for (const entry of walkFiles(root, { onError: (err) => errors.push(err) })) {
        entries += 1;
        allocated += entry.allocated;
        apparent += entry.logical;
        const mtimeMs = Number(entry.mtimeNs / 1_000_000n);

        if (mtimeMs > newest) {
            newest = mtimeMs;
        }

        budget.onFile?.(entry.path);
        const priv = resolvePrivateSize(entry);

        if (priv !== null) {
            privateSeen = true;
            privateSum += priv;
        }

        if (entries >= maxEntries || ((entries & 255) === 0 && Date.now() > deadline)) {
            complete = false;
            break;
        }
    }

    const floor = privateSeen ? Math.min(allocated, privateSum) : null;

    return {
        kind: "dir",
        allocatedBytes: allocated,
        apparentBytes: apparent,
        freeableFloorBytes: floor,
        entries,
        newestMtimeMs: newest,
        complete: complete && errors.length === 0,
        errors: errors.length,
    };
}

export interface PathsSize {
    allocatedBytes: number;
    apparentBytes: number;
    freeableFloorBytes: number | null;
    entries: number;
    newestMtimeMs: number;
    complete: boolean;
}

/** Sum of readable paths; any unreadable path makes the aggregate incomplete and its freeable floor unknown. */
export function measurePaths(paths: string[], budget: MeasureBudget = {}): PathsSize {
    let allocated = 0;
    let apparent = 0;
    let floor = 0;
    let floorKnown = true;
    let entries = 0;
    let newest = 0;
    let complete = true;

    for (const path of paths) {
        const size = measurePath(path, budget);

        if (!size) {
            complete = false;
            floorKnown = false;
            continue;
        }

        allocated += size.allocatedBytes;
        apparent += size.apparentBytes;
        entries += size.entries;
        newest = Math.max(newest, size.newestMtimeMs);
        complete = complete && size.complete;

        if (size.freeableFloorBytes === null) {
            floorKnown = false;
        } else {
            floor += size.freeableFloorBytes;
        }
    }

    return {
        allocatedBytes: allocated,
        apparentBytes: apparent,
        freeableFloorBytes: floorKnown && paths.length > 0 ? floor : null,
        entries,
        newestMtimeMs: newest,
        complete,
    };
}

export function ageDaysOf(mtimeMs: number, nowMs: number = Date.now()): number {
    return Math.max(0, Math.floor((nowMs - mtimeMs) / 86_400_000));
}
