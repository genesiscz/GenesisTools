import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { foldText, imageSize } from "@genesiscz/utils/macos/ocr-boxes";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { z } from "zod";
import { boxInProxy, type DisplayRange, framesForPlan, proxyCanvas, readDisplayPlan } from "./proxy";

const { log } = logger.scoped("recorder-screen-search");

const numeric = z.union([z.number(), z.string()]).transform(Number);
/** Vision's line observation as stored: bounds normalized, origin at the bottom left. */
const blockSchema = z.object({
    text: z.string(),
    bounds: z.object({ x: numeric, y: numeric, width: numeric, height: numeric }),
});
const ocrRowSchema = z.object({
    file: z.string(),
    text: z.string(),
    displayId: z.number().optional(),
    blocks: z.array(blockSchema).default([]),
});
const sidecarSchema = z.object({ text: z.string(), blocks: z.array(blockSchema).default([]) });
type FrameText = z.infer<typeof sidecarSchema>;

/** A matching OCR line where the proxy movie shows it: fractions of the movie's picture, from its top left. */
export interface ScreenBox {
    text: string;
    /** End of this line's consecutive visible run, when later than the hit's own frame. */
    untilSec?: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ScreenHit {
    /** Seconds on the recording's clock (the proxy movie's and the editor's source time). */
    sec: number;
    /** Until when this frame shows: the next frame of its display, else the recording's last frame plus 2 s. */
    untilSec: number;
    displayId?: number;
    file: string;
    /** The OCR lines of the frame that hold the query. */
    lines: string[];
    /** The proxy movie shows this display then (always true without a display plan). */
    shown: boolean;
    /** The lines that hold the query, placed over the proxy movie; empty when it does not show the frame. */
    boxes: ScreenBox[];
}

/** Each frame's OCR text: a meeting's (or a jsonl-sink recording's) `ocr.jsonl`, else the `<frame>.ocr.json` sidecars. */
export function frameTexts(folder: string, files: string[], wanted: string, limit: number): Map<string, FrameText> {
    const texts = new Map<string, FrameText>();
    const keep = (file: string, text: FrameText) => {
        if (foldText(text.text).includes(wanted)) {
            texts.set(file, text);
        }
        return texts.size >= limit;
    };
    const jsonl = join(folder, "ocr.jsonl");

    if (existsSync(jsonl)) {
        for (const line of readLinesSync(jsonl)) {
            const row = line.trim() ? ocrRowSchema.safeParse(SafeJSON.parse(line, { strict: true })) : undefined;

            if (row?.success) {
                if (keep(row.data.file, { text: row.data.text, blocks: row.data.blocks })) {
                    break;
                }
            }
        }

        return texts;
    }

    for (const file of files) {
        const sidecar = join(folder, `${file}.ocr.json`);

        if (existsSync(sidecar)) {
            const parsed = sidecarSchema.safeParse(SafeJSON.parse(readFileSync(sidecar, "utf8"), { strict: true }));

            if (parsed.success) {
                if (keep(file, parsed.data)) {
                    break;
                }
            }
        }
    }

    return texts;
}

/** A fraction to six places, so a box reads the same in JSON on every run. */
function micro(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
}

/** The pixel size of each display's first frame (one display's frames share a size); a missing file is left out. */
export function displaySizes(folder: string, frames: ReadonlyArray<{ file: string; displayId?: number }>) {
    const sizes = new Map<number | undefined, { width: number; height: number }>();

    for (const frame of frames) {
        if (sizes.has(frame.displayId)) {
            continue;
        }

        const path = join(folder, frame.file);

        try {
            sizes.set(frame.displayId, imageSize(path));
        } catch (error) {
            log.debug({ path, error }, "a frame's size does not read; its boxes are left out");
        }
    }

    return sizes;
}

/**
 * When the proxy movie shows each frame: the spans of `framesForPlan`'s schedule, a frame ending where the next shown
 * frame begins (the last at `endUs`). A frame the movie never shows has no entry. A frame can show more than once,
 * because the plan may leave its display and come back before the display's next frame.
 */
export function visibleSpans(
    frames: ReadonlyArray<{ file: string; atMs: number; displayId?: number }>,
    ranges: readonly DisplayRange[],
    endUs: number
): Map<string, Array<{ fromUs: number; toUs: number }>> {
    const schedule = framesForPlan(
        frames.map((frame) => ({ path: frame.file, atUs: frame.atMs * 1000, displayId: frame.displayId })),
        ranges
    );
    const spans = new Map<string, Array<{ fromUs: number; toUs: number }>>();

    for (const [index, shown] of schedule.entries()) {
        const toUs = schedule[index + 1]?.atUs ?? endUs;

        if (toUs > shown.atUs) {
            spans.set(shown.path, [...(spans.get(shown.path) ?? []), { fromUs: shown.atUs, toUs }]);
        }
    }

    return spans;
}

/**
 * Where a text was on the screen in a frames recording (a library recording with OCR, or a meeting): every frame whose
 * OCR holds `query` (without case and diacritics), with its time on the recording's clock, how long it shows, and the
 * matching lines' boxes over the proxy movie, oldest first.
 */
export function findOnScreen(folder: string, query: string, { limit = 50 }: { limit?: number } = {}): ScreenHit[] {
    const manifest = readRecordingManifest(folder);

    if (!manifest) {
        throw new Error(`${folder} has no recording.json; make the proxy first (it writes one for a meeting)`);
    }

    // A movie keeps no frames, so "no frame shows it" would read as "it was never on the screen".
    if (manifest.frames.length === 0) {
        throw new Error(
            `${folder} has no screen text: only a frames recording (tools recorder start --frames) or a meeting keeps the text it read off its screens`
        );
    }

    const wanted = foldText(query);

    if (!wanted) {
        return [];
    }

    const frames = [...manifest.frames].sort((a, b) => a.atMs - b.atMs);
    const texts = frameTexts(
        folder,
        frames.map((frame) => frame.file),
        wanted,
        Number.POSITIVE_INFINITY
    );
    const plan = readDisplayPlan(folder);
    const sizes = displaySizes(folder, frames);
    const shownDisplays = plan ? new Set(plan.ranges.map((range) => range.displayId)) : undefined;
    const canvas = proxyCanvas(
        [...sizes]
            .filter(([id]) => !shownDisplays || (id !== undefined && shownDisplays.has(id)))
            .map(([, size]) => size)
    );
    const lastMs = frames.at(-1)?.atMs ?? 0;
    const endUs = (lastMs + 2000) * 1000;
    const visible = plan ? visibleSpans(frames, plan.ranges, endUs) : undefined;
    const hits: ScreenHit[] = [];

    for (const [index, frame] of frames.entries()) {
        const read = texts.get(frame.file);
        const lines = (read?.text ?? "").split("\n").filter((line) => foldText(line).includes(wanted));

        if (lines.length === 0) {
            continue;
        }

        const next = frames.slice(index + 1).find((later) => later.displayId === frame.displayId);
        const size = sizes.get(frame.displayId);
        const boxes =
            size === undefined
                ? []
                : (read?.blocks ?? [])
                      .filter((block) => foldText(block.text).includes(wanted))
                      .map((block) => {
                          const placed = boxInProxy(
                              {
                                  x: block.bounds.x,
                                  y: 1 - block.bounds.y - block.bounds.height,
                                  width: block.bounds.width,
                                  height: block.bounds.height,
                              },
                              size,
                              canvas
                          );
                          return {
                              text: block.text,
                              x: micro(placed.x),
                              y: micro(placed.y),
                              width: micro(placed.width),
                              height: micro(placed.height),
                          };
                      });
        const spans =
            visible && frame.displayId !== undefined
                ? (visible.get(frame.file) ?? [])
                : [{ fromUs: frame.atMs * 1000, toUs: undefined }];
        const common = {
            ...(frame.displayId !== undefined ? { displayId: frame.displayId } : {}),
            file: frame.file,
            lines,
        };

        if (spans.length === 0) {
            hits.push({
                sec: frame.atMs / 1000,
                untilSec: (next?.atMs ?? lastMs + 2000) / 1000,
                ...common,
                shown: false,
                boxes: [],
            });
        }

        for (const span of spans) {
            hits.push({
                sec: span.fromUs / 1_000_000,
                untilSec: (span.toUs ?? (next?.atMs ?? lastMs + 2000) * 1000) / 1_000_000,
                ...common,
                shown: true,
                boxes: boxes.map((box) => ({ ...box })),
            });
        }
    }

    // Compare every later box to the starting box: no cumulative drift. OCR may jitter by 0.2% of the proxy
    // picture in x, y, width or height (inside the hide/mark padding); the full line text must be identical.
    // A missing line, an intervening frame or a proxy display switch ends the run, even if it returns later.
    const chronological = [...hits].sort((a, b) => a.sec - b.sec);
    for (const hit of hits.slice(0, limit)) {
        const index = chronological.indexOf(hit);
        for (const box of hit.boxes) {
            let end = hit.untilSec;
            for (const later of chronological.slice(index + 1)) {
                if (later.displayId !== hit.displayId) {
                    continue;
                }

                if (
                    !later.shown ||
                    later.sec !== end ||
                    !later.boxes.some(
                        (candidate) =>
                            candidate.text === box.text &&
                            Math.abs(candidate.x - box.x) <= 0.002 &&
                            Math.abs(candidate.y - box.y) <= 0.002 &&
                            Math.abs(candidate.width - box.width) <= 0.002 &&
                            Math.abs(candidate.height - box.height) <= 0.002
                    )
                ) {
                    break;
                }

                end = later.untilSec;
            }

            if (end > hit.untilSec) {
                box.untilSec = end;
            }
        }
    }

    return hits.slice(0, limit);
}
