import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { CAPTURE_FILE_MODE, type OcrRow } from "@genesiscz/utils/screen-recorder/frame-output";
import type { MotionBox } from "@genesiscz/utils/screen-recorder/types";
import { z } from "zod";

/**
 * A meeting's frame index, `frames.jsonl`: one line per frame the recorder kept, written right after the frame. The
 * recorder never waits on OCR; the OCR worker (`ocr-worker.ts`) reads the index and writes `ocr.jsonl`. Meetings
 * recorded before the index have only `ocr.jsonl`, whose rows name the same frames, so the index reader takes both.
 */

const { log } = logger.scoped("meetings-frame-index");

export const FRAME_INDEX_FILE = "frames.jsonl";
export const OCR_FILE = "ocr.jsonl";

export const frameIndexRowSchema = z.object({
    /** Relative to the meeting folder: `frames/<name>`. */
    file: z.string(),
    at: z.string(),
    displayId: z.number(),
    focusedDisplayId: z.number().optional(),
    changePercent: z.number(),
    reason: z.string(),
    motionBoxes: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).optional(),
});
export type FrameIndexRow = z.infer<typeof frameIndexRowSchema>;

/** An `ocr.jsonl` row as far as the index needs it; old rows lack the display, the change and the reason. */
const ocrIndexRowSchema = z.looseObject({
    file: z.string(),
    at: z.string(),
    displayId: z.number().optional(),
    focusedDisplayId: z.number().optional(),
    changePercent: z.number().optional(),
    reason: z.string().optional(),
});

export function frameIndexPath(folder: string): string {
    return join(folder, FRAME_INDEX_FILE);
}

export function ocrPath(folder: string): string {
    return join(folder, OCR_FILE);
}

/** Appends one kept frame to the meeting's index. */
export function appendFrameIndex(
    folder: string,
    frame: {
        file: string;
        at: Date;
        displayId: number;
        focusedDisplayId?: number;
        changePercent: number;
        reason: string;
        motionBoxes?: MotionBox[];
    }
): void {
    const row: FrameIndexRow = {
        file: frame.file,
        at: frame.at.toISOString(),
        displayId: frame.displayId,
        ...(frame.focusedDisplayId !== undefined ? { focusedDisplayId: frame.focusedDisplayId } : {}),
        changePercent: frame.changePercent,
        reason: frame.reason,
        ...(frame.motionBoxes ? { motionBoxes: frame.motionBoxes } : {}),
    };
    appendFileSync(frameIndexPath(folder), `${SafeJSON.stringify(row)}\n`, { mode: CAPTURE_FILE_MODE });
}

/** One index line, or undefined for a line an interrupted write cut short. */
export function parseFrameIndexLine(line: string, path: string): FrameIndexRow | undefined {
    let value: unknown;

    try {
        value = SafeJSON.parse(line, { strict: true });
    } catch (error) {
        log.debug({ path, error }, "skipped an unreadable frames.jsonl line");
        return undefined;
    }

    const parsed = frameIndexRowSchema.safeParse(value);

    if (!parsed.success) {
        log.debug({ path, error: parsed.error.message }, "skipped a frames.jsonl line that does not parse");
        return undefined;
    }

    return parsed.data;
}

function readIndexFile(path: string): FrameIndexRow[] {
    const rows: FrameIndexRow[] = [];

    for (const line of readLinesSync(path)) {
        if (!line.trim()) {
            continue;
        }

        const row = parseFrameIndexLine(line, path);

        if (row) {
            rows.push(row);
        }
    }

    return rows;
}

/** The frames `ocr.jsonl` names, as index rows (the migration of a meeting recorded before `frames.jsonl`). */
function indexFromOcr(path: string): FrameIndexRow[] {
    const rows: FrameIndexRow[] = [];

    for (const line of readLinesSync(path)) {
        if (!line.trim()) {
            continue;
        }

        let value: unknown;

        try {
            value = SafeJSON.parse(line, { strict: true });
        } catch (error) {
            log.debug({ path, error }, "skipped an unreadable ocr.jsonl row");
            continue;
        }

        const parsed = ocrIndexRowSchema.safeParse(value);

        if (!parsed.success) {
            log.debug({ path, error: parsed.error.message }, "skipped an ocr.jsonl row that is no frame");
            continue;
        }

        rows.push({
            file: parsed.data.file,
            at: parsed.data.at,
            displayId: parsed.data.displayId ?? frameDisplayId(parsed.data.file) ?? 0,
            ...(parsed.data.focusedDisplayId !== undefined ? { focusedDisplayId: parsed.data.focusedDisplayId } : {}),
            changePercent: parsed.data.changePercent ?? 0,
            reason: parsed.data.reason ?? "change",
        });
    }

    return rows;
}

/** The display of a frame name (`…-d4.jpg`). */
function frameDisplayId(file: string): number | undefined {
    const id = file.match(/-d(\d+)\.[a-z]+$/)?.[1];
    return id === undefined ? undefined : Number(id);
}

/**
 * Every frame the meeting kept, oldest first: the index, and the frames only `ocr.jsonl` names (a meeting or a run
 * from before the index). A frame both name takes the index line, which also has the motion boxes. A frame without an
 * OCR row yet is here: it is waiting for the OCR worker.
 */
export function readFrameIndex(folder: string): FrameIndexRow[] {
    const byFile = new Map<string, FrameIndexRow>();
    const ocr = ocrPath(folder);

    if (existsSync(ocr)) {
        for (const row of indexFromOcr(ocr)) {
            byFile.set(row.file, row);
        }
    }

    const index = frameIndexPath(folder);

    if (existsSync(index)) {
        for (const row of readIndexFile(index)) {
            byFile.set(row.file, row);
        }
    }

    // A stable sort by time keeps the written order of frames of one millisecond.
    return [...byFile.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Whether the meeting kept any frame: an index or an `ocr.jsonl` (a meeting from before the index). */
export function hasFrameIndex(folder: string): boolean {
    return existsSync(frameIndexPath(folder)) || existsSync(ocrPath(folder));
}

/**
 * The frame files `ocr.jsonl` has a row for. It reads only the start of each line: `SafeJSON.stringify` writes the
 * `file` key first, so a long row's blocks are never parsed; a line that starts otherwise is parsed whole.
 */
export function ocrRowFiles(path: string): Set<string> {
    const files = new Set<string>();

    if (!existsSync(path)) {
        return files;
    }

    for (const line of readLinesSync(path)) {
        if (!line.trim()) {
            continue;
        }

        const head = line.match(/^\{"file":"((?:[^"\\]|\\.)*)"/)?.[1];

        // The fast path takes only a row that closes and holds one row: a crash can leave a row cut after its file
        // name, and the next append then lands on the same line. Anything else is parsed whole.
        if (head !== undefined && !head.includes("\\") && line.endsWith("}") && !line.includes('{"file":"', 1)) {
            files.add(head);
            continue;
        }

        try {
            const value: unknown = SafeJSON.parse(line, { strict: true });
            const parsed = ocrIndexRowSchema.safeParse(value);

            if (parsed.success) {
                files.add(parsed.data.file);
            }
        } catch (error) {
            log.debug({ path, error }, "skipped an unreadable ocr.jsonl row");
        }
    }

    return files;
}

/** The lines of `frames.jsonl` alone, in written order; none for a meeting from before the index. */
export function readIndexRows(folder: string): FrameIndexRow[] {
    const index = frameIndexPath(folder);
    return existsSync(index) ? readIndexFile(index) : [];
}

/** What a screen reader says about kept frames the OCR worker has not read yet: "OCR pending (3 frames waiting)". */
export function ocrPendingNote(pending: number): string {
    return `OCR pending (${pending} ${pending === 1 ? "frame" : "frames"} waiting)`;
}

/** The frames of the index that have no OCR row yet, in index order. */
export function ocrBacklog(folder: string): FrameIndexRow[] {
    const index = frameIndexPath(folder);

    if (!existsSync(index)) {
        return [];
    }

    const done = ocrRowFiles(ocrPath(folder));
    return readIndexFile(index).filter((row) => !done.has(row.file));
}

/**
 * Reads the lines appended to `frames.jsonl` since the last call, from a byte offset: a worker that follows a running
 * recording reads each line once. A line still being written stays for the next call.
 */
export class FrameIndexTail {
    private offset = 0;
    /** The bytes after the last newline: a line still being written (kept as bytes, so no character is cut). */
    private remainder: Buffer = Buffer.alloc(0);

    constructor(readonly path: string) {}

    readNew(): FrameIndexRow[] {
        if (!existsSync(this.path)) {
            return [];
        }

        const fd = openSync(this.path, "r");
        let bytes: Buffer;

        try {
            const size = fstatSync(fd).size;

            if (size < this.offset) {
                log.warn({ path: this.path, size, offset: this.offset }, "frames.jsonl shrank; reading it again");
                this.offset = 0;
                this.remainder = Buffer.alloc(0);
            }

            const length = size - this.offset;

            if (length <= 0) {
                return [];
            }

            const buffer = Buffer.alloc(length);
            const read = readSync(fd, buffer, 0, length, this.offset);
            this.offset += read;
            bytes = Buffer.concat([this.remainder, buffer.subarray(0, read)]);
        } finally {
            closeSync(fd);
        }

        const end = bytes.lastIndexOf(0x0a);

        if (end < 0) {
            this.remainder = bytes;
            return [];
        }

        this.remainder = Buffer.from(bytes.subarray(end + 1));
        return bytes
            .subarray(0, end)
            .toString("utf8")
            .split("\n")
            .flatMap((line) => {
                if (!line.trim()) {
                    return [];
                }

                const row = parseFrameIndexLine(line, this.path);
                return row ? [row] : [];
            });
    }
}

/** An `ocr.jsonl` row back as the index line of its frame, for a worker that reads the frame again. */
export function indexRowOf(row: OcrRow, motionBoxes?: MotionBox[]): FrameIndexRow {
    return {
        file: row.file,
        at: row.at,
        displayId: row.displayId,
        changePercent: row.changePercent,
        reason: row.reason,
        ...(motionBoxes ? { motionBoxes } : {}),
    };
}
