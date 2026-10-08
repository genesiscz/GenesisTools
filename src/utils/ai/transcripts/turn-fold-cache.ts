import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { markBefore } from "./file-scan";
import { parseTranscriptLine } from "./parse-line";
import type { TranscriptTurn } from "./types";

/** A turn parser that keeps its state between calls (codex.ts `createCodexTurnParser`). */
export interface TurnFold {
    push(lines: readonly (string | unknown)[]): void;
    snapshot(): TranscriptTurn[];
}

interface FoldEntry {
    ino: number;
    /** Bytes up to and including the last newline already pushed into `fold`. */
    consumed: number;
    mark: string;
    fold: TurnFold;
    /** A record carried `method`: a Codex app-server event file, which another builder reads. */
    events: boolean;
    lastUsed: number;
}

/** Smaller files are parsed whole: a full parse of 8 MB costs ~10 ms. */
const FOLD_MIN_BYTES = 8 * 1024 * 1024;
/** Files kept: a live follow reads one or two at a time. A parser holds its turns (~17 MB for a 163 MB rollout). */
const FOLD_FILES = 3;
/** A parser nobody read for this long is dropped, so a transcript nobody watches holds no memory. */
const FOLD_IDLE_MS = 60_000;
const folds = new Map<string, FoldEntry>();
let sweep: ReturnType<typeof setTimeout> | null = null;

function scheduleSweep(): void {
    if (sweep) {
        return;
    }

    sweep = setTimeout(() => {
        sweep = null;
        const now = Date.now();
        for (const [path, entry] of folds) {
            if (now - entry.lastUsed > FOLD_IDLE_MS) {
                folds.delete(path);
            }
        }

        if (folds.size > 0) {
            scheduleSweep();
        }
    }, FOLD_IDLE_MS);
    // Never what keeps a process alive.
    sweep.unref?.();
}

function keep(path: string, entry: FoldEntry): void {
    folds.delete(path);
    folds.set(path, entry);
    if (folds.size > FOLD_FILES) {
        const oldest = folds.keys().next().value;
        if (oldest !== undefined) {
            folds.delete(oldest);
        }
    }

    scheduleSweep();
}

/**
 * The turns of a large JSONL transcript as a full parse returns them, from a parser that already read the file up
 * to its last complete line and now reads only what was appended. A live Codex rollout of 163 MB cost ~185 ms of
 * reading and parsing on every write (2026-10-08: read 52, JSON 107, turns 25), and a resident server held the
 * file's text, lines and records in memory meanwhile.
 *
 * Null when the caller must parse the whole file itself: a small file, a file whose records carry `method` (an
 * app-server event file), or a last line without its newline that already parses (a full parse reads it; this
 * parser pushes only complete lines). A file replaced (another inode), shorter, or with other bytes at its start or
 * before the kept end is read again from its start.
 */
export function foldTurnsAppendOnly(
    path: string,
    create: () => TurnFold,
    { minBytes = FOLD_MIN_BYTES }: { minBytes?: number } = {}
): TranscriptTurn[] | null {
    let fd: number | null = null;
    try {
        // A stat, not an open, for the common small file: the full parse opens it next.
        if (statSync(path).size < minBytes) {
            folds.delete(path);
            return null;
        }

        fd = openSync(path, "r");
        const { size, ino } = fstatSync(fd);
        const cached = folds.get(path);
        const usable =
            cached !== undefined &&
            cached.ino === ino &&
            cached.consumed <= size &&
            markBefore(fd, cached.consumed) === cached.mark;
        const entry: FoldEntry =
            usable && cached
                ? cached
                : { ino, consumed: 0, mark: "", fold: create(), events: false, lastUsed: Date.now() };
        entry.lastUsed = Date.now();
        keep(path, entry);
        if (entry.events) {
            return null;
        }

        const fresh = Buffer.allocUnsafe(size - entry.consumed);
        let read = 0;
        while (read < fresh.length) {
            const got = readSync(fd, fresh, read, fresh.length - read, entry.consumed + read);
            if (got === 0) {
                break;
            }
            read += got;
        }

        const bytes = fresh.subarray(0, read);
        const lastNewline = bytes.lastIndexOf(10);
        if (lastNewline !== -1) {
            const records: Record<string, unknown>[] = [];
            for (const line of bytes
                .subarray(0, lastNewline + 1)
                .toString("utf8")
                .split("\n")) {
                const record = parseTranscriptLine(line);
                if (record) {
                    records.push(record);
                    entry.events ||= "method" in record;
                }
            }

            entry.fold.push(records);
            entry.consumed += lastNewline + 1;
            entry.mark = markBefore(fd, entry.consumed);
            if (entry.events) {
                return null;
            }
        }

        const unfinished = bytes.subarray(lastNewline + 1).toString("utf8");
        if (parseTranscriptLine(unfinished)) {
            return null;
        }

        return entry.fold.snapshot();
    } catch (error) {
        logger.debug({ error, path }, "[transcripts] transcript fold unreadable; parsing the whole file");
        folds.delete(path);
        return null;
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}
