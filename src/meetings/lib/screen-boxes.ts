import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    boxesHolding,
    changedLines,
    foldText,
    frameBoxes,
    imageSize,
    matchingBoxes,
    type OcrBox,
    type OcrBoxLevel,
    padBox,
} from "@genesiscz/utils/macos/ocr-boxes";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { z } from "zod";
import { CallTimeline } from "./call-timeline";
import { readRecorderState } from "./recorder-shared";
import {
    type DisplayFrames,
    framesAtPerDisplay,
    type OcrLine,
    ocrLineSchema,
    type RecordedSpan,
    recordedDisplaySpans,
    recordedSpans,
    type ScreenFrame,
} from "./screen";

const { log } = logger.scoped("meetings-screen-boxes");

const numeric = z.union([z.number(), z.string()]);

/** A full row of a meeting's `ocr.jsonl`: the frame, its change, and Vision's blocks (normalized bounds). */
export const ocrRowSchema = ocrLineSchema.extend({
    changePercent: z.number().optional(),
    reason: z.string().optional(),
    blocks: z
        .array(
            z.object({
                text: z.string(),
                confidence: z.number(),
                bounds: z.object({ x: numeric, y: numeric, width: numeric, height: numeric }),
            })
        )
        .default([]),
});
export type OcrRow = z.infer<typeof ocrRowSchema>;

/** Every row of `ocr.jsonl`, in the order the recorder wrote them; a row that does not parse is skipped. */
export function readOcrRows(path: string): OcrRow[] {
    const rows: OcrRow[] = [];

    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        let value: unknown;
        try {
            value = SafeJSON.parse(line, { strict: true });
        } catch (error) {
            log.debug({ path, error }, "an ocr.jsonl row is malformed");
            continue;
        }
        const parsed = ocrRowSchema.safeParse(value);

        if (parsed.success) {
            rows.push(parsed.data);
        } else {
            log.debug({ path, error: parsed.error.message }, "an ocr.jsonl row does not parse");
        }
    }

    return rows;
}

/** The frames whose text holds `query` (without case and diacritics), oldest first, at most `limit`. */
export function framesMatching(rows: OcrRow[], query: string, limit: number): OcrRow[] {
    const wanted = foldText(query);
    return rows.filter((row) => wanted && foldText(row.text).includes(wanted)).slice(0, limit);
}

export interface ScreenBoxesRequest {
    /** The meeting folder (frames are `<folder>/<row.file>`). */
    folder: string;
    /** Every row of the meeting's `ocr.jsonl`: the earlier frame of a display comes from them. */
    rows: OcrRow[];
    /** The frames to draw, by their `file`. */
    files: string[];
    /** Boxes whose text holds this; without it, the boxes whose text the display's earlier frame did not show. */
    match?: string;
    level: OcrBoxLevel;
    outDir: string;
    /** Pixels around each crop. Default 12. */
    pad?: number;
    /** At most this many crops per frame, largest first. Default 24. */
    maxCrops?: number;
}

export interface ScreenBoxFrame {
    file: string;
    at: string;
    displayId?: number;
    selection: "match" | "changed";
    width: number;
    height: number;
    /** The selected boxes in frame pixels (top-left origin), numbered as drawn. */
    boxes: OcrBox[];
    /** The frame with the numbered boxes drawn; null when no box was selected. */
    annotated: string | null;
    /** One PNG per box (`<frame>.<n>.png`), in the order of `boxes`, up to `maxCrops`. */
    crops: string[];
}

function previousRow(rows: OcrRow[], row: OcrRow): OcrRow | undefined {
    const at = rows.findIndex((one) => one.file === row.file);
    return rows.slice(0, Math.max(0, at)).findLast((one) => one.displayId === row.displayId);
}

/**
 * For each frame: picks its line or block boxes (the match, or what changed since the display's earlier frame), draws
 * them numbered on the frame, and writes a crop of each, so a note can show only the part of the screen that matters.
 */
export async function renderScreenBoxes(request: ScreenBoxesRequest): Promise<ScreenBoxFrame[]> {
    // lazy: saves 101 ms of every meetings command that reads OCR rows (tools ts imports lazy, 2026-11-06): @napi-rs/canvas loads the system fonts at import, and only drawn boxes need it
    const { renderAnnotationPlan } = await import("@genesiscz/utils/image/render-plan");
    const pad = request.pad ?? 12;
    const maxCrops = request.maxCrops ?? 24;
    mkdirSync(request.outDir, { recursive: true });
    const results: ScreenBoxFrame[] = [];

    for (const file of request.files) {
        const row = request.rows.find((one) => one.file === file);
        const image = join(request.folder, file);

        if (!row || !existsSync(image)) {
            log.warn({ file, image }, "a frame for boxes is missing");
            continue;
        }

        const size = imageSize(image);
        const current = frameBoxes(row.blocks, size);
        const before = previousRow(request.rows, row);
        const lines = request.match
            ? matchingBoxes(current.lines, request.match)
            : changedLines(before ? frameBoxes(before.blocks, size).lines : undefined, current.lines);
        const boxes = request.level === "line" ? lines : boxesHolding(current.blocks, lines);
        const stem = basename(file, extname(file));
        const result: ScreenBoxFrame = {
            file,
            at: row.at,
            ...(row.displayId !== undefined ? { displayId: row.displayId } : {}),
            selection: request.match ? "match" : "changed",
            width: size.width,
            height: size.height,
            boxes,
            annotated: null,
            crops: [],
        };

        if (boxes.length > 0) {
            const drawn = await renderAnnotationPlan({
                input: image,
                annotations: boxes.map((box, index) => ({
                    kind: "box" as const,
                    rect: { x: box.x, y: box.y, w: box.width, h: box.height },
                    style: { strokeWidth: 3, radius: 4 },
                    label: { text: String(index + 1), position: "top-left" as const, style: { fontSize: 16 } },
                })),
            });
            result.annotated = join(request.outDir, `${stem}.boxes.png`);
            writeFileSync(result.annotated, drawn.png);
            const largest = boxes
                .map((box, index) => ({ box, index }))
                .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)
                .slice(0, maxCrops)
                .sort((a, b) => a.index - b.index);

            for (const { box, index } of largest) {
                const rect = padBox(box, pad, size);
                const crop = await renderAnnotationPlan({
                    input: image,
                    annotations: [{ kind: "crop", rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } }],
                });
                const path = join(request.outDir, `${stem}.${index + 1}.png`);
                writeFileSync(path, crop.png);
                result.crops.push(path);
            }
        }

        results.push(result);
    }

    log.info(
        { frames: results.length, boxes: results.reduce((sum, one) => sum + one.boxes.length, 0), out: request.outDir },
        "screen boxes written"
    );
    return results;
}

export interface MeetingScreenRequest {
    store: MeetingStore;
    record: MeetingRecord;
    /** A transcript time in seconds; without it, the frames that show `match`. */
    atSec?: number;
    /** How wide a window around `atSec`. Default 30. */
    windowSec?: number;
    match?: string;
    /** Without `atSec`: at most this many matching frames. Default 5. */
    limit?: number;
    /** Draw the boxes and write the crops (`renderScreenBoxes`). */
    boxes?: { level?: OcrBoxLevel; outDir: string; pad?: number; maxCrops?: number };
}

export interface MeetingScreen {
    /** The transcript's zero on the wall clock (ms). */
    zeroMs: number;
    spans: RecordedSpan[];
    /** False when the screen was not recorded at `atSec`. */
    recorded: boolean;
    displays: DisplayFrames[];
    frames: Array<ScreenFrame & { meetingSec: number }>;
    boxes?: ScreenBoxFrame[];
}

/** The running recorder's display intervals when it records this meeting; they are newer than the record's. */
function liveDisplaySpans(store: MeetingStore, meetingId: string) {
    const live = readRecorderState(store);
    return live.running && live.state?.meetingId === meetingId ? live.state.displaySpans : undefined;
}

/** The frames of a meeting at a transcript moment or for a search text, with their boxes when asked. */
export async function meetingScreen(request: MeetingScreenRequest): Promise<MeetingScreen> {
    const { store, record } = request;
    const folder = store.folder(record.id);
    const ocrPath = join(folder, "ocr.jsonl");

    if (!existsSync(ocrPath)) {
        throw new Error(`${record.id} has no screen recording (no ocr.jsonl)`);
    }

    if (request.atSec === undefined && !request.match) {
        throw new Error("give a transcript time (atSec) or a text to match");
    }

    const zeroMs = (await CallTimeline.forRecord(record)).zeroMs;
    const rows = readOcrRows(ocrPath);
    const spans = recordedSpans(record);
    const lines: OcrLine[] = rows.map((row) => ocrLineSchema.parse(row));
    const picked =
        request.atSec === undefined
            ? {
                  recorded: true,
                  displays: [
                      {
                          frames: framesMatching(rows, request.match ?? "", request.limit ?? 5).map((row) =>
                              ocrLineSchema.parse(row)
                          ),
                      },
                  ],
              }
            : framesAtPerDisplay({
                  lines,
                  spans,
                  displaySpans: recordedDisplaySpans(record, { live: liveDisplaySpans(store, record.id) }),
                  targetMs: zeroMs + request.atSec * 1000,
                  windowMs: (request.windowSec ?? 30) * 1000,
              });
    const frames = picked.displays
        .flatMap((display) => display.frames)
        .map((frame) => ({ ...frame, meetingSec: (Date.parse(frame.at) - zeroMs) / 1000 }));
    const screen: MeetingScreen = { zeroMs, spans, recorded: picked.recorded, displays: picked.displays, frames };

    if (request.boxes) {
        screen.boxes = await renderScreenBoxes({
            folder,
            rows,
            files: [...new Set(frames.map((frame) => frame.file))],
            ...(request.match ? { match: request.match } : {}),
            level: request.boxes.level ?? "block",
            outDir: request.boxes.outDir,
            ...(request.boxes.pad !== undefined ? { pad: request.boxes.pad } : {}),
            ...(request.boxes.maxCrops !== undefined ? { maxCrops: request.boxes.maxCrops } : {}),
        });
    }

    return screen;
}
