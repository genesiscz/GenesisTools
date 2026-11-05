import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    statfsSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { rmDataDir } from "./config";

const MB = 1024 * 1024;

/** Below this much free space a `tools rm` run gives the reserve back before it writes anything. */
export const DISK_RESERVE_RELEASE_BELOW = 64 * MB;

/** The reserve is made again only when the disk keeps this much room beside it. */
export const DISK_RESERVE_REFILL_MARGIN = 2048 * MB;

export function diskReservePath(): string {
    return rmDataDir("disk-reserve.bin");
}

/** Where the reserve lives, and how free space is read (a test passes a full disk). */
export interface DiskReserveOptions {
    path?: string;
    free?: (path: string) => number | null;
}

export type DiskReserveOutcome =
    | { action: "released"; bytes: number; free: number }
    | { action: "made"; bytes: number; free: number }
    | { action: "removed"; bytes: number }
    | { action: "kept"; free: number | null };

/** Free bytes an unprivileged writer gets on the volume of `path` (its nearest existing folder), or null. */
export function freeBytes(path: string): number | null {
    let folder = path;

    while (!existsSync(folder) && dirname(folder) !== folder) {
        folder = dirname(folder);
    }

    try {
        const stats = statfsSync(folder);
        return stats.bavail * stats.bsize;
    } catch (error) {
        logger.debug({ folder, error }, "rm: the volume did not report its free space");
        return null;
    }
}

function sizeOf(path: string): number | null {
    return statSync(path, { throwIfNoEntry: false })?.size ?? null;
}

/**
 * Deletes the reserve when the disk is nearly full, so this run can write its locks, requests and ledger lines. On
 * 2026-11-05 `tools rm approve` failed with ENOSPC at its first lock file on a full disk: the one tool that frees
 * space could not run. One statfs per run, and an unlink when it acts.
 */
export function releaseDiskReserveIfFull(options: DiskReserveOptions = {}): DiskReserveOutcome {
    const path = options.path ?? diskReservePath();
    const bytes = sizeOf(path);

    if (bytes === null) {
        return { action: "kept", free: null };
    }

    const free = (options.free ?? freeBytes)(path);

    if (free === null || free >= DISK_RESERVE_RELEASE_BELOW) {
        return { action: "kept", free };
    }

    try {
        unlinkSync(path);
    } catch (error) {
        logger.warn({ path, error }, "rm: could not release the disk reserve");
        return { action: "kept", free };
    }

    logger.warn({ path, bytes, free }, "rm: the disk is nearly full, so the disk reserve was released");
    return { action: "released", bytes, free };
}

/**
 * Makes the reserve of `megabytes` (0 removes it) when the disk keeps `DISK_RESERVE_REFILL_MARGIN` beside it, so the
 * next full disk finds it. Zeros are written for real: APFS allocates every written block, while a truncated file
 * would be sparse and hold nothing. The daily pass runs it.
 */
export function keepDiskReserve(options: DiskReserveOptions & { megabytes: number }): DiskReserveOutcome {
    const path = options.path ?? diskReservePath();
    const want = Math.round(options.megabytes * MB);
    const have = sizeOf(path);

    if (want === 0) {
        if (have === null) {
            return { action: "kept", free: null };
        }

        unlinkSync(path);
        logger.info({ path, bytes: have }, "rm: the disk reserve is off, so its file was removed");
        return { action: "removed", bytes: have };
    }

    if (have !== null && have >= want) {
        return { action: "kept", free: null };
    }

    const free = (options.free ?? freeBytes)(path);

    if (free === null || free < want - (have ?? 0) + DISK_RESERVE_REFILL_MARGIN) {
        return { action: "kept", free };
    }

    const draft = `${path}.${process.pid}.tmp`;
    mkdirSync(dirname(path), { recursive: true });

    try {
        writeZeros(draft, want);
        renameSync(draft, path);
    } catch (error) {
        try {
            unlinkSync(draft);
        } catch (cleanup) {
            logger.debug({ draft, error: cleanup }, "rm: no disk reserve draft to remove");
        }

        throw error;
    }

    logger.info({ path, bytes: want, free }, "rm: made the disk reserve");
    return { action: "made", bytes: want, free };
}

function writeZeros(path: string, bytes: number): void {
    const chunk = Buffer.alloc(Math.min(bytes, MB));
    const fd = openSync(path, "w");

    try {
        for (let written = 0; written < bytes; ) {
            written += writeSync(fd, chunk, 0, Math.min(chunk.length, bytes - written));
        }

        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}
