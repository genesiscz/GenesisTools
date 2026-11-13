/**
 * The shared half of `HookFacts.compactedSince`: a bounded read of a transcript's tail and the scan for a compaction
 * row. Each harness supplies its dialect (`<harness>-compaction.ts`). Light on purpose, like `session-model.ts`: the
 * shell guard calls it from a hook, so it imports no logger and no reader.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * How much of a transcript's end the scan reads. The plugin's area-rules hook found a compaction row up to 670 KB
 * before the next rows; this is the same bound it uses.
 */
export const COMPACTION_TAIL_BYTES = 4 * 1024 * 1024;

/** One row as a dialect reads it: its time, and whether it marks a compaction. */
export interface CompactionRow {
    at: number;
    compaction: boolean;
}

export interface CompactionDialect {
    /** A substring every compaction row carries, so the scan parses only those rows. */
    needle: string;
    /** The row's time and kind; undefined for a row it cannot read (the tail's cut first row, a row being written). */
    parse(row: string): CompactionRow | undefined;
}

/**
 * Whether the transcript records a compaction at or after `sinceMs`. When the answer is not known (no file, a
 * compressed one, a tail that does not reach back to `sinceMs`), it is true: a repeated explanation costs context, a
 * lost one costs a wrong command.
 */
export function compactedInTail(
    path: string,
    sinceMs: number,
    dialect: CompactionDialect,
    tailBytes = COMPACTION_TAIL_BYTES
): boolean {
    if (path.endsWith(".zst")) {
        return true;
    }

    let text: string;
    let whole: boolean;

    try {
        const fd = openSync(path, "r");

        try {
            const size = fstatSync(fd).size;
            const length = Math.min(size, tailBytes);
            const buffer = Buffer.alloc(length);
            readSync(fd, buffer, 0, length, size - length);
            text = buffer.toString("utf8");
            whole = length === size;
        } finally {
            closeSync(fd);
        }
    } catch {
        // No transcript at this path, or no permission: unknown. Not logged, for the same reason as `session-model.ts`.
        return true;
    }

    const lines = text.split("\n");
    // The first line of a partial tail is cut.
    const rows = whole ? lines : lines.slice(1);

    for (const row of rows) {
        if (!row.includes(dialect.needle)) {
            continue;
        }

        const read = dialect.parse(row);

        if (read?.compaction && read.at >= sinceMs) {
            return true;
        }
    }

    if (whole) {
        return false;
    }

    for (const row of rows) {
        const read = dialect.parse(row);

        if (read) {
            return read.at > sinceMs;
        }
    }

    return true;
}
