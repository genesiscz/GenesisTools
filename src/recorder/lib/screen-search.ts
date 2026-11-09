import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { foldText, imageSize } from "@genesiscz/utils/macos/ocr-boxes";
import { framesMovieEndUs } from "@genesiscz/utils/recording-editor/source";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { z } from "zod";
import { boxInProxy, type DisplayPlan, framesForPlan, proxyCanvas, readDisplayPlan } from "./proxy";

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
    /**
     * Until when this frame shows: the next frame of its display, else until the recording ends (the proxy holds its
     * last frame).
     */
    untilSec: number;
    displayId?: number;
    /** The frame file; absent for a movie recording, whose text is read off the movie itself. */
    file?: string;
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

/** When the proxy movie shows a frame of a frames recording, and until when the frame was on its own screen. */
export interface FrameShow {
    /** The spans the proxy movie shows the frame; empty when its display plan never shows it. */
    spans: Array<{ fromUs: number; toUs: number }>;
    /** The next frame of its display, else the end of the movie. */
    untilUs: number;
}

/**
 * When the proxy movie shows each frame (`frames` sorted by time, the answer in their order). With a display plan:
 * the spans of `framesForPlan`'s schedule, a frame ending where the next shown frame begins. A frame the movie never
 * shows has none, and a frame can show more than once, because the plan may leave its display and come back before
 * the display's next frame. Without a plan: from the frame to the next frame of its display. The last frame shows
 * until the movie ends (framesMovieEndUs), as makeProxy holds it, which is the recording's end when it has one.
 */
export function frameShows({
    frames,
    plan,
    startedAt,
    endedAt,
}: {
    frames: ReadonlyArray<{ file: string; atMs: number; displayId?: number }>;
    plan: Pick<DisplayPlan, "ranges"> | undefined;
    startedAt?: string;
    endedAt?: string;
}): FrameShow[] {
    const timed = frames.map((frame) => ({ path: frame.file, atUs: frame.atMs * 1000, displayId: frame.displayId }));
    const schedule = plan ? framesForPlan(timed, plan.ranges) : [];
    const endUs = framesMovieEndUs({ frames: timed, schedule, startedAt, endedAt });
    const visible = new Map<string, Array<{ fromUs: number; toUs: number }>>();

    for (const [index, shown] of schedule.entries()) {
        const toUs = schedule[index + 1]?.atUs ?? endUs;

        if (toUs > shown.atUs) {
            visible.set(shown.path, [...(visible.get(shown.path) ?? []), { fromUs: shown.atUs, toUs }]);
        }
    }

    const nextUs = new Map<number | undefined, number>();
    const shows: FrameShow[] = [];

    for (let index = frames.length - 1; index >= 0; index--) {
        const frame = frames[index];
        const untilUs = nextUs.get(frame.displayId) ?? endUs;
        nextUs.set(frame.displayId, frame.atMs * 1000);
        shows[index] = {
            spans:
                plan && frame.displayId !== undefined
                    ? (visible.get(frame.file) ?? [])
                    : [{ fromUs: frame.atMs * 1000, toUs: untilUs }],
            untilUs,
        };
    }

    return shows;
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
            `${folder} has no screen text: only a frames recording (${toolCommand("recorder start", "--frames")}) or a meeting keeps the text it read off its screens`
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
    // The proxy's picture holds every display that has frames, whichever the plan shows (makeProxy).
    const canvas = proxyCanvas([...sizes.values()]);
    const shows = frameShows({ frames, plan, startedAt: manifest.startedAt, endedAt: manifest.endedAt });
    const hits: ScreenHit[] = [];

    for (const [index, frame] of frames.entries()) {
        const read = texts.get(frame.file);
        const lines = (read?.text ?? "").split("\n").filter((line) => foldText(line).includes(wanted));

        if (lines.length === 0) {
            continue;
        }

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
        const { spans, untilUs } = shows[index];
        const common = {
            ...(frame.displayId !== undefined ? { displayId: frame.displayId } : {}),
            file: frame.file,
            lines,
        };

        if (spans.length === 0) {
            hits.push({
                sec: frame.atMs / 1000,
                untilSec: untilUs / 1_000_000,
                ...common,
                shown: false,
                boxes: [],
            });
        }

        for (const span of spans) {
            hits.push({
                sec: span.fromUs / 1_000_000,
                untilSec: span.toUs / 1_000_000,
                ...common,
                shown: true,
                boxes: boxes.map((box) => ({ ...box })),
            });
        }
    }

    // Oldest first, so --limit keeps the earliest moments: a frame the plan shows twice has a hit per showing, and
    // a later frame can play between them. The file breaks a tie, so the order never depends on the frame list.
    hits.sort((a, b) => a.sec - b.sec || (a.file ?? "").localeCompare(b.file ?? ""));
    return extendBoxRuns(hits, limit);
}

/**
 * The first `limit` hits (oldest first), each box running on while the same line stays in the same place in the
 * next hits: its untilSec is where that run ends, so hiding it covers the whole time the line shows.
 */
export function extendBoxRuns(hits: ScreenHit[], limit: number): ScreenHit[] {
    // Compare every later box to the starting box: no cumulative drift. OCR may jitter by 0.2% of the proxy
    // picture in x, y, width or height (inside the hide/mark padding); the full line text must be identical.
    // A missing line, an intervening frame or a proxy display switch ends the run, even if it returns later.
    for (const [index, hit] of hits.slice(0, limit).entries()) {
        for (const box of hit.boxes) {
            let end = hit.untilSec;
            for (const later of hits.slice(index + 1)) {
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
