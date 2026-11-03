import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { z } from "zod";

/** One frame's line in a meeting's `ocr.jsonl`. */
export const ocrLineSchema = z.object({ file: z.string(), at: z.string(), text: z.string() });
export type OcrLine = z.infer<typeof ocrLineSchema>;

/** A frame shown for a moment; `unchanged` marks the frame taken before the window that was still on the screen. */
export type ScreenFrame = OcrLine & { unchanged?: true };

export interface RecordedSpan {
    fromMs: number;
    toMs: number;
}

/** When the recorder ran, from the meeting's history: each `record start` that reached the screen until its stop. */
export function recordedSpans(record: MeetingRecord, now = Date.now()): RecordedSpan[] {
    const spans: RecordedSpan[] = [];
    let open: number | undefined;

    for (const entry of record.history) {
        if (entry.command === "record start" && entry.change.startsWith("display ")) {
            open = Date.parse(entry.at);
        } else if (entry.command === "record stop" && open !== undefined) {
            spans.push({ fromMs: open, toMs: Date.parse(entry.at) });
            open = undefined;
        }
    }

    if (open !== undefined) {
        spans.push({ fromMs: open, toMs: record.recording?.status === "recording" ? now : open });
    }

    return spans;
}

/**
 * The frames for a moment: those within half the window of it and, since a frame is taken only when the screen
 * changes, the last frame before it in the same recorded span, which was still on the screen then.
 */
export function framesAt(options: { lines: OcrLine[]; spans: RecordedSpan[]; targetMs: number; windowMs: number }): {
    frames: ScreenFrame[];
    recorded: boolean;
} {
    const { lines, targetMs } = options;
    const half = options.windowMs / 2;
    const near: ScreenFrame[] = lines.filter((line) => Math.abs(Date.parse(line.at) - targetMs) <= half);
    const span = options.spans.find((one) => targetMs >= one.fromMs && targetMs <= one.toMs);

    if (!span) {
        return { frames: near, recorded: false };
    }

    const onScreen = lines.findLast((line) => {
        const at = Date.parse(line.at);
        return at >= span.fromMs && at <= targetMs;
    });

    if (!onScreen || near.some((line) => line.file === onScreen.file)) {
        return { frames: near, recorded: true };
    }

    return { frames: [{ ...onScreen, unchanged: true }, ...near], recorded: true };
}
