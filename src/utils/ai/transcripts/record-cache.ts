import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { markBefore } from "./file-scan";
import { parseTranscriptLine } from "./parse-line";

interface RecordsEntry {
    ino: number;
    /** Bytes up to and including the last newline already parsed into `records`. */
    consumed: number;
    mark: string;
    records: Record<string, unknown>[];
}

/** Smaller files are parsed whole: the saving does not pay for the memory a cache holds. */
const CACHE_MIN_BYTES = 8 * 1024 * 1024;
/** Files kept: a live follow reads one or two at a time, and each holds its parsed records in memory. */
const CACHE_FILES = 3;
const cache = new Map<string, RecordsEntry>();

function parseLines(text: string, into: Record<string, unknown>[]): void {
    for (const line of text.split("\n")) {
        const parsed = parseTranscriptLine(line);
        if (parsed) {
            into.push(parsed);
        }
    }
}

/**
 * Every JSON record of a JSONL transcript, like a full read, but a large file that only grew since the last
 * call is parsed only from the old end. A live Codex rollout of 163 MB cost 150 ms of reading and parsing on
 * every write it got (a working session writes several a second; 2026-10-08), for a turn assembly of 25 ms.
 *
 * Complete lines are kept; an unfinished last line is parsed fresh each time and never kept. A file replaced
 * (another inode), shorter, or with other bytes at its start or before the kept end is read whole again.
 * The records are shared between calls: callers read them and build their own objects (the turn builders
 * copy what they keep), and must not change them.
 */
export function readRecordsAppendOnly(
    path: string,
    { minCacheBytes = CACHE_MIN_BYTES }: { minCacheBytes?: number } = {}
): Record<string, unknown>[] {
    let fd: number | null = null;
    try {
        fd = openSync(path, "r");
        const { size, ino } = fstatSync(fd);
        const cached = cache.get(path);
        const usable =
            cached !== undefined &&
            cached.ino === ino &&
            cached.consumed <= size &&
            markBefore(fd, cached.consumed) === cached.mark;
        const entry: RecordsEntry = usable && cached ? cached : { ino, consumed: 0, mark: "", records: [] };
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
        const complete = lastNewline === -1 ? bytes.subarray(0, 0) : bytes.subarray(0, lastNewline + 1);
        const unfinished = lastNewline === -1 ? bytes : bytes.subarray(lastNewline + 1);
        if (complete.length > 0) {
            const records = entry === cached ? entry.records : [];
            parseLines(complete.toString("utf8"), records);
            entry.records = records;
            entry.consumed += complete.length;
            entry.mark = markBefore(fd, entry.consumed);
        }

        const tail: Record<string, unknown>[] = [];
        parseLines(unfinished.toString("utf8"), tail);
        if (size >= minCacheBytes) {
            cache.delete(path);
            cache.set(path, entry);
            if (cache.size > CACHE_FILES) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) {
                    cache.delete(oldest);
                }
            }
        } else {
            cache.delete(path);
        }

        return tail.length > 0 ? [...entry.records, ...tail] : entry.records;
    } catch (error) {
        logger.debug({ error, path }, "[transcripts] transcript records unreadable");
        return [];
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}
