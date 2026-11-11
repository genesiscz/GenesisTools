import { existsSync } from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { changedLines, frameBoxes, imageSize, type OcrBox } from "@genesiscz/utils/macos/ocr-boxes";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { CallTimeline } from "./call-timeline";
import { type OcrRow, readOcrRows } from "./screen-boxes";

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
}

export interface ScreenTimeline {
    meeting: string;
    folder: string;
    displays: Array<{ id?: number; name?: string; frames: number }>;
    frames: TimelineFrame[];
}

/** Where one requested frame sits in the sorted rows, and the same display's frame before it that `changed` compares with. */
interface WantedFrame {
    index: number;
    /** -1 when the frame is its display's first. */
    earlier: number;
    displayId: number | undefined;
}

function wantedFrame(rows: OcrRow[], file: string): WantedFrame | null {
    const index = rows.findIndex((row) => row.file === file);

    if (index < 0) {
        return null;
    }

    const displayId = rows[index]?.displayId;
    const earlier = rows.slice(0, index).findLastIndex((row) => row.displayId === displayId);

    return { index, earlier, displayId };
}

/**
 * Every frame of a meeting's screen recording in time order, each with the OCR lines that changed since the same
 * display's earlier frame. A frame's size is read once per display (every frame of one display has its size). Reads
 * only. `all` adds every line of each frame. `frame` keeps only the frame with that file (its changed lines still
 * compare with the display's earlier frame) and adds its every line; a `frame` it does not hold throws. A `frame`
 * request turns OCR lines into boxes for that frame and the display's frame before it only, and stops at the frame.
 */
export async function screenTimeline(options: {
    store: MeetingStore;
    record: MeetingRecord;
    all?: boolean;
    frame?: string;
}): Promise<ScreenTimeline> {
    const { store, record } = options;
    const folder = store.folder(record.id);
    const ocrPath = join(folder, "ocr.jsonl");

    if (!existsSync(ocrPath)) {
        throw new Error(`${record.id} has no screen recording (no ocr.jsonl)`);
    }

    const zeroMs = (await CallTimeline.forRecord(record)).zeroMs;
    const rows = readOcrRows(ocrPath).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const sizes = new Map<number | undefined, { width: number; height: number }>();
    const previous = new Map<number | undefined, OcrBox[]>();
    const frames: TimelineFrame[] = [];
    // A frame the timeline does not hold is an error, not an empty answer: the window would show no text and no reason.
    const noFrame = () =>
        new Error(
            `No frame "${options.frame}" in ${record.id}. List the frames: ${toolCommand("meetings", "screen", record.id, "--timeline")}`
        );
    const wanted = options.frame ? wantedFrame(rows, options.frame) : null;

    if (options.frame && !wanted) {
        throw noFrame();
    }

    for (const [index, row] of rows.entries()) {
        // One frame: the rows after it and other displays' rows play no part; the earlier rows of its display only
        // find the display's size, as they do for the whole timeline.
        if (wanted && index > wanted.index) {
            break;
        }

        if (wanted && row.displayId !== wanted.displayId) {
            continue;
        }

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

        if (wanted && index !== wanted.index && index !== wanted.earlier) {
            continue;
        }

        const boxes = frameBoxes(row.blocks, size).lines;
        const changed = changedLines(previous.get(row.displayId), boxes);
        previous.set(row.displayId, boxes);

        if (wanted && index !== wanted.index) {
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
        });
    }

    // The frame's file and every earlier one of its display are gone, so its size is unknown.
    if (options.frame && frames.length === 0) {
        throw noFrame();
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
    };
}
