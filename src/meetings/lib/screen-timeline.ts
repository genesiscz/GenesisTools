import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { changedLines, frameBoxes, imageSize, type OcrBox } from "@genesiscz/utils/macos/ocr-boxes";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { CallTimeline } from "./call-timeline";
import { hasFrameIndex } from "./frame-index";
import { readScreenRows } from "./screen-boxes";

const { log } = logger.scoped("meetings-screen-timeline");

export interface TimelineFrame {
    /** The frame's file, relative to the meeting folder (`frames/16-32-42-232-d4.jpg`). */
    file: string;
    /** Its absolute path. */
    path: string;
    at: string;
    /** Seconds on the transcript clock. */
    meetingSec: number;
    displayId?: number;
    width: number;
    height: number;
    /** Every OCR line of the frame. */
    lineCount: number;
    /** The lines the display's earlier frame did not show, in frame pixels (top-left origin). */
    changed: OcrBox[];
    /** Every line, only with `all`. */
    lines?: OcrBox[];
    /** The OCR worker has not read this frame yet: it has no lines so far. */
    pending?: true;
}

export interface ScreenTimeline {
    meeting: string;
    folder: string;
    displays: Array<{ id?: number; name?: string; frames: number }>;
    frames: TimelineFrame[];
    /** Kept frames the OCR worker has not read yet; they are among the frames, as `pending`. */
    pending: number;
}

/**
 * Every frame of a meeting's screen recording in time order, each with the OCR lines that changed since the same
 * display's earlier frame. A frame's size is read once per display (every frame of one display has its size). Reads
 * only. `all` adds every line of each frame. `frame` keeps only the frame with that file (its changed lines still
 * compare with the display's earlier frame) and adds its every line.
 */
export async function screenTimeline(options: {
    store: MeetingStore;
    record: MeetingRecord;
    all?: boolean;
    frame?: string;
}): Promise<ScreenTimeline> {
    const { store, record } = options;
    const folder = store.folder(record.id);
    if (!hasFrameIndex(folder)) {
        throw new Error(`${record.id} has no screen recording (no frames.jsonl or ocr.jsonl)`);
    }

    const zeroMs = (await CallTimeline.forRecord(record)).zeroMs;
    const screenRows = readScreenRows(folder);
    const rows = screenRows.rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const sizes = new Map<number | undefined, { width: number; height: number }>();
    const previous = new Map<number | undefined, OcrBox[]>();
    const frames: TimelineFrame[] = [];

    for (const row of rows) {
        const path = join(folder, row.file);
        let size = sizes.get(row.displayId);

        if (!size) {
            if (!existsSync(path)) {
                log.debug({ path }, "a frame file is gone (retention); its row is skipped");
                continue;
            }

            size = imageSize(path);
            sizes.set(row.displayId, size);
        }

        // A frame OCR has not read yet shows no lines and leaves its display's earlier lines as they were.
        const boxes = row.pending ? [] : frameBoxes(row.blocks, size).lines;
        const changed = row.pending ? [] : changedLines(previous.get(row.displayId), boxes);

        if (!row.pending) {
            previous.set(row.displayId, boxes);
        }

        if (options.frame && row.file !== options.frame) {
            continue;
        }

        frames.push({
            file: row.file,
            path,
            at: row.at,
            meetingSec: Math.round((Date.parse(row.at) - zeroMs) / 100) / 10,
            ...(row.displayId !== undefined ? { displayId: row.displayId } : {}),
            width: size.width,
            height: size.height,
            lineCount: boxes.length,
            changed,
            ...(options.all || options.frame ? { lines: boxes } : {}),
            ...(row.pending ? { pending: true } : {}),
        });
    }

    const names = new Map((record.recording?.displays ?? []).map((display) => [display.id, display.name]));
    const counts = new Map<number | undefined, number>();

    for (const frame of frames) {
        counts.set(frame.displayId, (counts.get(frame.displayId) ?? 0) + 1);
    }

    return {
        meeting: record.id,
        folder,
        displays: [...counts].map(([id, count]) => ({
            ...(id !== undefined ? { id } : {}),
            ...(id !== undefined && names.get(id) ? { name: names.get(id) } : {}),
            frames: count,
        })),
        frames,
        pending: screenRows.pending,
    };
}
