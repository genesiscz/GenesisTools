import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { JsonValue } from "./source-scan";
import type { ForwardRead, ForwardRow, NativeHistoryEntry, NativeSourceIssue, ReadForwardOptions } from "./types";

const CHUNK_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;

/** The start of every line in `data[0, end)` that contains one of `needles`, in file order. */
function matchingLineStarts(data: Buffer, end: number, needles: readonly Buffer[]): number[] {
    const starts = new Set<number>();

    for (const needle of needles) {
        let at = data.indexOf(needle, 0);

        while (at !== -1 && at < end) {
            const start = at === 0 ? 0 : data.lastIndexOf(NEWLINE, at - 1) + 1;
            starts.add(start);
            const lineEnd = data.indexOf(NEWLINE, at);
            at = lineEnd === -1 || lineEnd >= end ? -1 : data.indexOf(needle, lineEnd + 1);
        }
    }

    return [...starts].sort((a, b) => a - b);
}

function everyLineStart(data: Buffer, end: number): number[] {
    const starts: number[] = [];
    let start = 0;

    while (start < end) {
        starts.push(start);
        const lineEnd = data.indexOf(NEWLINE, start);

        if (lineEnd === -1) {
            break;
        }

        start = lineEnd + 1;
    }

    return starts;
}

/**
 * The shared half of every provider's `readForward`: one JSONL file read from `fromOffset` to its length when the read
 * began, each complete row turned into entries by the provider's `rowEntries` and keyed by its `rowKey`. With
 * `contains`, only rows whose raw bytes hold one of the strings are decoded and parsed, so a 500 MB transcript costs a
 * byte search, not a parse. The provider owns the format; this owns the walk. A row cut short at the end (still being
 * written) is left for the next read: `endOffset` stops before it.
 */
export function readJsonlForward(
    options: ReadForwardOptions & {
        path: string;
        rowEntries: (row: JsonValue, line: number, position: number) => NativeHistoryEntry[];
        rowKey: (row: JsonValue, position: number) => string;
    }
): ForwardRead {
    const issues: NativeSourceIssue[] = [];
    const rows: ForwardRow[] = [];
    const needles = (options.contains ?? []).filter(Boolean).map((text) => Buffer.from(text, "utf8"));
    let fd: number;

    try {
        fd = openSync(options.path, "r");
    } catch (error) {
        const message = `Forward read could not open the source: ${error instanceof Error ? error.message : String(error)}`;
        logger.warn({ path: options.path, error }, message);
        return { rows, file: null, endOffset: 0, issues: [{ path: options.path, message }] };
    }

    try {
        // The identity is taken before any byte is read: a write during the read leaves a newer size than this one.
        const stat = fstatSync(fd);
        const size = stat.size;
        const file = { path: options.path, ino: stat.ino, size };
        const from = Math.max(0, options.fromOffset);

        if (from > size) {
            return { rows, file, endOffset: from, issues };
        }

        let position = from;
        let carry: Buffer = Buffer.alloc(0);

        while (position < size) {
            if (options.signal?.aborted) {
                const message = `Forward read aborted at byte ${position - carry.length} of ${size}`;
                logger.warn({ path: options.path, position, size }, message);
                issues.push({ path: options.path, message });
                return { rows, file, endOffset: position - carry.length, issues };
            }

            const want = Math.min(CHUNK_BYTES, size - position);
            const chunk = Buffer.allocUnsafe(want);
            const got = readSync(fd, chunk, 0, want, position);

            if (got <= 0) {
                break;
            }

            const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);
            const base = position - carry.length;
            position += got;
            const lastNewline = data.lastIndexOf(NEWLINE);

            if (lastNewline === -1) {
                carry = data;
                continue;
            }

            const end = lastNewline + 1;
            const starts = needles.length > 0 ? matchingLineStarts(data, end, needles) : everyLineStart(data, end);

            for (const start of starts) {
                const lineEnd = data.indexOf(NEWLINE, start);
                const text = data.toString("utf8", start, lineEnd).trim();

                if (!text) {
                    continue;
                }

                let row: JsonValue;

                try {
                    row = SafeJSON.parse(text, { strict: true }) as JsonValue;
                } catch {
                    const message = `Unreadable row at byte ${base + start}; skipped`;
                    logger.warn({ path: options.path, position: base + start }, message);
                    issues.push({ path: options.path, message });
                    continue;
                }

                const offset = base + start;
                rows.push({
                    key: options.rowKey(row, offset),
                    offset,
                    entries: options.rowEntries(row, rows.length + 1, offset),
                });
            }

            carry = Buffer.from(data.subarray(end));
        }

        return { rows, file, endOffset: position - carry.length, issues };
    } finally {
        closeSync(fd);
    }
}
