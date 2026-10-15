import {
    appendFileSync,
    closeSync,
    existsSync,
    fstatSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CMUX_REFS_MAX_AGE_MS, CMUX_REFS_PATH } from "@genesiscz/utils/cmux/session-refs";
import { claimPrivateFolder, freeDestination, moveAsideRoot } from "@genesiscz/utils/fs/move-aside";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

const log = logger.child({ component: "cmux:journal-compact" });

/** Every line this young is kept whole: a restore right after a crash reads the recent lines of a busy tab. */
export const JOURNAL_RECENT_MS = 24 * 60 * 60 * 1000;

export interface JournalCompactionStats {
    linesBefore: number;
    linesAfter: number;
    bytesBefore: number;
    bytesAfter: number;
    dropped: {
        /** Older than the readers' window (`CMUX_REFS_MAX_AGE_MS`): no reader looks at them. */
        aged: number;
        /** Neither the first nor the last line of their session on that surface, not an end marker, not recent. */
        redundant: number;
        /** Not JSON, or no session id, or no numeric `at`: every reader skips them. */
        unreadable: number;
    };
}

interface ParsedLine {
    index: number;
    at: number;
    ended: boolean;
    group: string;
}

/**
 * Which lines of the journal text to keep. Pure: `now` is a parameter, nothing is read or written.
 *
 * The readers (`loadAllSessionCmuxRefs` and everything built on it) need, per session, the newest line inside the
 * window and the oldest line inside the window on that surface (`firstAt`). So for every (session, surface,
 * provider) this keeps the line with the smallest `at` and the line with the largest `at` (the later one in the
 * file on a tie, as the readers do), plus every `ended` line and every line from the last 24 hours. Kept lines
 * keep their bytes and their order.
 */
export function planJournalCompaction(text: string, now: number): { text: string; stats: JournalCompactionStats } {
    const rawLines = text.split("\n");
    const cutoff = now - CMUX_REFS_MAX_AGE_MS;
    const recentFrom = now - JOURNAL_RECENT_MS;
    const dropped = { aged: 0, redundant: 0, unreadable: 0 };
    const candidates: ParsedLine[] = [];
    let linesBefore = 0;

    rawLines.forEach((line, index) => {
        if (!line.trim()) {
            return;
        }

        linesBefore += 1;
        const parsed = parseLine(line, index);

        if (!parsed) {
            dropped.unreadable += 1;
        } else if (parsed.at < cutoff) {
            dropped.aged += 1;
        } else {
            candidates.push(parsed);
        }
    });

    const first = new Map<string, ParsedLine>();
    const last = new Map<string, ParsedLine>();

    for (const line of candidates) {
        const firstSoFar = first.get(line.group);
        const lastSoFar = last.get(line.group);

        if (!firstSoFar || line.at < firstSoFar.at) {
            first.set(line.group, line);
        }

        if (!lastSoFar || line.at >= lastSoFar.at) {
            last.set(line.group, line);
        }
    }

    const kept: string[] = [];

    for (const line of candidates) {
        if (line.ended || line.at >= recentFrom || first.get(line.group) === line || last.get(line.group) === line) {
            kept.push(rawLines[line.index]);
        } else {
            dropped.redundant += 1;
        }
    }

    const compacted = kept.length > 0 ? `${kept.join("\n")}\n` : "";

    return {
        text: compacted,
        stats: {
            linesBefore,
            linesAfter: kept.length,
            bytesBefore: Buffer.byteLength(text),
            bytesAfter: Buffer.byteLength(compacted),
            dropped,
        },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function parseLine(line: string, index: number): ParsedLine | null {
    let entry: unknown;

    try {
        entry = SafeJSON.parse(line, { jsonl: true });
    } catch (err) {
        log.debug({ err, lineLength: line.length }, "unreadable journal line");

        return null;
    }

    if (!isRecord(entry)) {
        return null;
    }

    const { sessionId, at, surfaceId, provider, ended } = entry;

    if (typeof sessionId !== "string" || typeof at !== "number") {
        return null;
    }

    return {
        index,
        at,
        ended: ended === true,
        group: `${sessionId.toLowerCase()}\n${typeof surfaceId === "string" ? surfaceId.toLowerCase() : ""}\n${typeof provider === "string" ? provider : ""}`,
    };
}

export interface CompactJournalOptions {
    path?: string;
    now?: number;
    /** Report what would change; write nothing, back nothing up. */
    dryRun?: boolean;
    /** Where older `.bak` files go. Default: the day's move-aside folder under /tmp (cleared at reboot). */
    asideDir?: string;
    /** Test seams for the two moments a hook can append: after the read, and right after the rename. */
    onRead?: () => void;
    onRenamed?: () => void;
}

export interface CompactJournalResult extends JournalCompactionStats {
    path: string;
    dryRun: boolean;
    /** False when nothing would be dropped: the file is left alone and no backup is made. */
    changed: boolean;
    /** The copy of the journal as it was read. Null on a dry run or an unchanged journal. */
    backupPath: string | null;
    /** Older `.bak` files moved to the aside folder. */
    movedBackups: string[];
    /** Bytes other writers appended after the read and before the rename, carried into the new file. */
    carriedBytes: number;
}

const BACKUP_PATTERN = /\.\d{8}-\d{6}\.bak$/;

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

function backupStamp(now: number): string {
    const date = new Date(now);

    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Everything from `offset` to the current end of the file behind `fd`. */
function readFrom(fd: number, offset: number): Buffer {
    const size = fstatSync(fd).size;

    if (size <= offset) {
        return Buffer.alloc(0);
    }

    const buffer = Buffer.alloc(size - offset);
    let filled = 0;

    while (filled < buffer.length) {
        const read = readSync(fd, buffer, filled, buffer.length - filled, offset + filled);

        if (read === 0) {
            break;
        }

        filled += read;
    }

    return buffer.subarray(0, filled);
}

/** Older backups next to the journal go to the aside folder; one that cannot be moved stays where it is. */
function moveOlderBackups({ path, keep, asideDir }: { path: string; keep: string; asideDir: string }): string[] {
    const prefix = `${basename(path)}.`;
    const older = readdirSync(dirname(path))
        .filter((name) => name.startsWith(prefix) && BACKUP_PATTERN.test(name))
        .map((name) => join(dirname(path), name))
        .filter((file) => file !== keep);

    if (older.length === 0) {
        return [];
    }

    const problem = claimPrivateFolder(asideDir);

    if (problem) {
        log.warn({ problem, asideDir }, "older journal backups stay next to the journal");

        return [];
    }

    const moved: string[] = [];

    for (const file of older) {
        const destination = freeDestination(join(asideDir, basename(file)));

        try {
            renameSync(file, destination);
            moved.push(destination);
        } catch (err) {
            log.warn({ err, file, destination }, "an older journal backup could not be moved aside; it stays");
        }
    }

    return moved;
}

/**
 * Rewrite the surface journal without the lines no reader needs (`planJournalCompaction`).
 *
 * Writers are hooks that open the file by path and append one line (`O_APPEND`), with no lock. So the rewrite
 * reads through one file descriptor, writes a temp file beside the journal, and before the rename copies in every
 * byte appended after its read, then reads the old file once more after the rename for a hook that had it open.
 * A second compaction that replaced the journal in between is detected by its inode, and nothing is changed.
 * The remaining race: a hook that opened the old file before the rename and appends after that last read loses
 * its line, which the session's next prompt or heartbeat writes again.
 *
 * What stays identical at the moment of the compaction are the answers of the readers that look at now:
 * `loadAllSessionCmuxRefs` (newest line and `firstAt`) and `loadSurfaceSessions`. Two things can differ later or
 * elsewhere: a historical read (`beforeMs`, restore from the previous autosave) sees only the first and last line
 * of a session for the time before the last 24 hours, and once the kept first line of a long session ages out of
 * the 7-day window, `firstAt` jumps to the next kept line instead of the next original one.
 */
export function compactJournal(options: CompactJournalOptions = {}): CompactJournalResult {
    const path = options.path ?? CMUX_REFS_PATH;
    const now = options.now ?? Date.now();
    const dryRun = options.dryRun ?? false;
    const result: CompactJournalResult = {
        path,
        dryRun,
        changed: false,
        backupPath: null,
        movedBackups: [],
        carriedBytes: 0,
        linesBefore: 0,
        linesAfter: 0,
        bytesBefore: 0,
        bytesAfter: 0,
        dropped: { aged: 0, redundant: 0, unreadable: 0 },
    };

    if (!existsSync(path)) {
        return result;
    }

    const fd = openSync(path, "r");

    try {
        const identity = fstatSync(fd);
        const bytes = readFileSync(fd);
        // A line another hook is still writing has no newline yet: it is not planned, it is carried over.
        const completeLength = bytes.lastIndexOf(0x0a) + 1;
        const plan = planJournalCompaction(bytes.subarray(0, completeLength).toString("utf8"), now);
        const fragment = bytes.length - completeLength;

        Object.assign(result, plan.stats, {
            bytesBefore: bytes.length,
            bytesAfter: plan.stats.bytesAfter + fragment,
        });
        result.changed = plan.stats.linesAfter !== plan.stats.linesBefore;

        if (!result.changed || dryRun) {
            log.debug({ ...summary(result) }, dryRun ? "journal compaction dry run" : "journal already compact");

            return result;
        }

        options.onRead?.();

        // The copy is what was read, made before the journal is touched: a failure here changes nothing.
        const backupPath = `${path}.${backupStamp(now)}.bak`;
        writeFileSync(backupPath, bytes, { flag: "wx" });
        result.backupPath = backupPath;

        const onDisk = statSync(path);

        if (onDisk.ino !== identity.ino || onDisk.dev !== identity.dev) {
            throw new Error(`${path} was replaced while it was compacted; nothing was changed (backup: ${backupPath})`);
        }

        const tail = readFrom(fd, completeLength);

        atomicWriteFileSync(path, Buffer.concat([Buffer.from(plan.text, "utf8"), tail]));
        options.onRenamed?.();

        const late = readFrom(fd, completeLength + tail.length);

        if (late.length > 0) {
            appendFileSync(path, late);
        }

        result.carriedBytes = tail.length - fragment + late.length;
        result.bytesAfter = plan.stats.bytesAfter + tail.length + late.length;
        result.movedBackups = moveOlderBackups({
            path,
            keep: backupPath,
            asideDir: options.asideDir ?? moveAsideRoot({ context: "cmux-journal-backups" }),
        });
        log.debug({ ...summary(result), backupPath }, "journal compacted");

        return result;
    } finally {
        closeSync(fd);
    }
}

function summary(result: CompactJournalResult) {
    const { linesBefore, linesAfter, bytesBefore, bytesAfter, dropped, path } = result;

    return { path, linesBefore, linesAfter, bytesBefore, bytesAfter, dropped };
}
