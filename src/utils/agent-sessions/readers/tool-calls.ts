import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { NativeSourceIssue, NativeToolCall, ToolCallsRead } from "../types";

/** A read that starts on an existing transcript (or fell far behind) takes at most its newest this-many bytes, once. */
export const TOOL_CALLS_BACKFILL_BYTES = 16 * 1024 * 1024;

/**
 * The complete lines a transcript gained since `from` that hold one of `markers`, each handed to `parse` in file
 * order, and the offset after the last complete line: a line still being written is left for the next call. A file
 * that shrank was replaced and is read from its start. The harnesses' `readToolCalls` share it; only `parse` knows a
 * format. Measured on a 128 MB Claude transcript: the bytes appended between two Bash calls are 11.9 KB at p50 and
 * 271 KB at p99, and scanning them costs well under a millisecond.
 */
export function readToolCallLines({
    path,
    from,
    markers,
    parse,
}: {
    path: string;
    from: number;
    markers: readonly string[];
    parse: (line: string, into: NativeToolCall[], issues: NativeSourceIssue[]) => void;
}): ToolCallsRead {
    const calls: NativeToolCall[] = [];
    const issues: NativeSourceIssue[] = [];
    let fd: number;

    try {
        fd = openSync(path, "r");
    } catch (err) {
        issues.push({ path, message: `could not open the transcript to read its tool calls: ${String(err)}` });
        return { supported: true, calls, offset: from, issues };
    }

    try {
        const size = fstatSync(fd).size;
        let start = from > size ? 0 : from;

        if (size - start > TOOL_CALLS_BACKFILL_BYTES) {
            issues.push({
                path,
                message: `read only the newest ${TOOL_CALLS_BACKFILL_BYTES} bytes; ${size - TOOL_CALLS_BACKFILL_BYTES - start} older bytes after offset ${start} were skipped`,
            });
            start = size - TOOL_CALLS_BACKFILL_BYTES;
        }

        if (size <= start) {
            return { supported: true, calls, offset: start, issues };
        }

        const buf = Buffer.allocUnsafe(size - start);
        const read = readSync(fd, buf, 0, buf.length, start);
        const data = buf.subarray(0, read);
        const lastNewline = data.lastIndexOf(0x0a);

        if (lastNewline === -1) {
            return { supported: true, calls, offset: start, issues };
        }

        // A read that began mid-line skips that fragment.
        const first = start === from ? 0 : data.indexOf(0x0a) + 1;
        const lineStarts = new Set<number>();

        for (const marker of markers.map((m) => Buffer.from(m))) {
            let cursor = first;

            while (cursor <= lastNewline) {
                const hit = data.indexOf(marker, cursor);

                if (hit === -1 || hit > lastNewline) {
                    break;
                }

                const lineStart = data.lastIndexOf(0x0a, hit) + 1;
                lineStarts.add(Math.max(lineStart, first));
                cursor = data.indexOf(0x0a, hit) + 1;
            }
        }

        for (const lineStart of [...lineStarts].sort((a, b) => a - b)) {
            parse(data.subarray(lineStart, data.indexOf(0x0a, lineStart)).toString("utf8"), calls, issues);
        }

        return { supported: true, calls, offset: start + lastNewline + 1, issues };
    } finally {
        closeSync(fd);
    }
}
