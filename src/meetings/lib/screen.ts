import { formatBytes } from "@genesiscz/utils/format";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { z } from "zod";

/** One frame's line in a meeting's `ocr.jsonl`. */
export const ocrLineSchema = z.object({
    file: z.string(),
    at: z.string(),
    /** The display the frame shows; absent in recordings from before several displays. */
    displayId: z.number().optional(),
    text: z.string(),
});
export type OcrLine = z.infer<typeof ocrLineSchema>;

/** A frame shown for a moment; `unchanged` marks the frame taken before the window that was still on the screen. */
export type ScreenFrame = OcrLine & { unchanged?: true };

export interface RecordedSpan {
    fromMs: number;
    toMs: number;
}

/**
 * When the recorder ran: the `recording.spans` it keeps (pauses end a span), and before them, for recordings from before
 * the spans, each `record start` in the history that reached the screen until its stop.
 */
export function recordedSpans(record: MeetingRecord, now = Date.now()): RecordedSpan[] {
    const kept = (record.recording?.spans ?? []).map((span) => {
        const fromMs = Date.parse(span.from);
        const open = record.recording?.status === "recording" ? now : fromMs;
        return { fromMs, toMs: span.to ? Date.parse(span.to) : open };
    });
    const firstKept = kept[0]?.fromMs ?? Number.POSITIVE_INFINITY;
    return [...historySpans(record, now).filter((span) => span.toMs <= firstKept), ...kept];
}

function historySpans(record: MeetingRecord, now: number): RecordedSpan[] {
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

export interface DisplayFrames {
    /** Absent for frames of a recording from before several displays. */
    displayId?: number;
    frames: ScreenFrame[];
}

/** `framesAt` for each display on its own: the frame still on each screen, not the last frame of any screen. */
export function framesAtPerDisplay(options: {
    lines: OcrLine[];
    spans: RecordedSpan[];
    targetMs: number;
    windowMs: number;
}): {
    displays: DisplayFrames[];
    recorded: boolean;
} {
    const groups = new Map<number | undefined, OcrLine[]>();

    for (const line of options.lines) {
        let group = groups.get(line.displayId);

        if (!group) {
            group = [];
            groups.set(line.displayId, group);
        }

        group.push(line);
    }

    let recorded = false;
    const displays: DisplayFrames[] = [];

    for (const [displayId, lines] of [...groups].sort(([a], [b]) => (a ?? -1) - (b ?? -1))) {
        const one = framesAt({ ...options, lines });
        recorded ||= one.recorded;

        if (one.frames.length > 0) {
            displays.push({ ...(displayId !== undefined ? { displayId } : {}), frames: one.frames });
        }
    }

    if (groups.size === 0) {
        recorded = framesAt({ ...options, lines: [] }).recorded;
    }

    return { displays, recorded };
}

/** The lines `show` prints about the screen recording: its state, frames per display, the spans, and its warning. */
export function recordingSummary(record: MeetingRecord, now = Date.now()): string[] {
    const recording = record.recording;

    if (!recording) {
        return [];
    }

    const frames = recording.frames ?? 0;
    const state = `${recording.status ?? "unknown"}${recording.stopReason ? ` (${recording.stopReason})` : ""}`;
    const size = recording.bytes !== undefined ? `, ${formatBytes(recording.bytes)}` : "";
    const lines = [
        `- recording: ${state}, ${frames === 0 ? "no frames" : `${frames} frames`}${size}${recording.backend ? `, ${recording.backend}` : ""}`,
    ];
    const displays = recording.displays ?? [];

    if (displays.length > 0) {
        lines.push(
            `- displays: ${displays.map((display) => `${display.name} (${display.id}) ${display.frames}`).join(", ")}`
        );
    }

    const spans = recordedSpans(record, now);

    if (spans.length > 0) {
        const clock = (ms: number) => localTime(new Date(ms).toISOString()).slice(11);
        lines.push(`- recorded: ${spans.map((span) => `${clock(span.fromMs)}–${clock(span.toMs)}`).join(", ")}`);
    }

    if (recording.warning) {
        lines.push(`- recording warning: ${recording.warning}`);
    }

    return lines;
}
