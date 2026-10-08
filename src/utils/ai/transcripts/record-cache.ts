import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { readPrefixMark } from "./file-scan";
import { parseTranscriptLine } from "./parse-line";

interface RecordsEntry {
    ino: number;
    /** Bytes up to and including the last newline already parsed into `records`. */
    consumed: number;
    mark: string;
    records: Record<string, unknown>[];
    /** The file's size when last read, for the memory budget. */
    bytes: number;
    lastUsed: number;
}

/** Smaller files are parsed whole: the saving does not pay for the memory a cache holds. */
const CACHE_MIN_BYTES = 8 * 1024 * 1024;
/**
 * Parsed records take about five times the file's bytes in memory: a 163 MB rollout held 848 MB (2026-10-08). A
 * file larger than this is parsed whole on every read instead, and all cached files together stay under
 * `CACHE_TOTAL_BYTES` of source (≈ 500 MB of records at most).
 */
const CACHE_MAX_FILE_BYTES = 48 * 1024 * 1024;
const CACHE_TOTAL_BYTES = 96 * 1024 * 1024;
/** An entry no read touched for this long is dropped, so a transcript nobody watches holds no memory. */
const CACHE_IDLE_MS = 60_000;
const cache = new Map<string, RecordsEntry>();
let sweep: ReturnType<typeof setTimeout> | null = null;

function scheduleSweep(): void {
    if (sweep) {
        return;
    }

    sweep = setTimeout(() => {
        sweep = null;
        const now = Date.now();
        for (const [path, entry] of cache) {
            if (now - entry.lastUsed > CACHE_IDLE_MS) {
                cache.delete(path);
            }
        }

        if (cache.size > 0) {
            scheduleSweep();
        }
    }, CACHE_IDLE_MS);
    // Never what keeps a process alive.
    sweep.unref?.();
}

/** Keep `path` within the budget: drop the least recently used entries until the total fits. */
function keep(path: string, entry: RecordsEntry): void {
    cache.delete(path);
    cache.set(path, entry);
    let total = 0;
    for (const item of cache.values()) {
        total += item.bytes;
    }

    for (const [other, item] of cache) {
        if (total <= CACHE_TOTAL_BYTES || other === path) {
            break;
        }

        cache.delete(other);
        total -= item.bytes;
    }

    scheduleSweep();
}

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
 * Only files from 8 MB (`CACHE_MIN_BYTES`) to 48 MB (`CACHE_MAX_FILE_BYTES`) are kept: a larger live transcript is
 * still parsed whole on every read, for the memory reason above. Codex turns have their own bounded fold
 * (turn-fold-cache.ts); Grok has none.
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
        let prefix = readPrefixMark(fd, cached?.ino === ino && cached.consumed <= size ? cached.consumed : 0);
        const usable =
            cached !== undefined && cached.ino === ino && cached.consumed <= size && prefix.digest() === cached.mark;
        const entry: RecordsEntry =
            usable && cached ? cached : { ino, consumed: 0, mark: "", records: [], bytes: size, lastUsed: Date.now() };
        if (!usable) {
            prefix = readPrefixMark(fd, 0);
        }

        entry.bytes = size;
        entry.lastUsed = Date.now();
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
            prefix.update(complete);
        }

        const tail: Record<string, unknown>[] = [];
        parseLines(unfinished.toString("utf8"), tail);
        const checkpoint = prefix.finish();
        entry.mark = checkpoint.digest;
        if (checkpoint.stable && size >= minCacheBytes && size <= CACHE_MAX_FILE_BYTES) {
            keep(path, entry);
        } else {
            cache.delete(path);
        }

        return tail.length > 0 ? [...entry.records, ...tail] : entry.records;
    } catch (error) {
        // Thrown, as the whole-file read it replaced threw: an unreadable transcript is an error, never an empty one.
        cache.delete(path);
        logger.debug({ error, path }, "[transcripts] transcript records unreadable");
        throw error;
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}
