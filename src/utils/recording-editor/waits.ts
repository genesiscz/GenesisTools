import { createHash } from "node:crypto";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const { log } = logger.scoped("recording-editor-waits");

/**
 * Typing and waiting: stretches of a screen movie where only a small part of the picture changes (a line being typed,
 * a spinner, a progress bar) or nothing does, for at least a few seconds. Each becomes a proposed speed-up of 4x to
 * 8x. The picture is compared on a small grey copy, cell by cell, so encoder noise and a clock tick stay small.
 */

/** The grey copy's width in pixels; its height follows the movie's shape. */
export const WAIT_SAMPLE_WIDTH = 160;
/** Pictures compared per second. */
export const WAIT_SAMPLE_FPS = 4;
/** One cell of the comparison grid, in pixels of the grey copy. */
const CELL = 10;
/** A pixel counts as changed past this much grey. */
const PIXEL_NOISE = 18;
/** A cell counts as changed when at least this many of its pixels did. */
const CELL_PIXELS = 3;

/** One step from a picture to the next: how many grid cells changed, of how many, and their bounding box in cells. */
export interface ChangeStep {
    changed: number;
    cells: number;
    box?: { x0: number; y0: number; x1: number; y1: number };
}

/** The grid's size for a grey copy of `width` by `height` pixels. */
export function gridOf(width: number, height: number): { columns: number; rows: number } {
    return { columns: Math.ceil(width / CELL), rows: Math.ceil(height / CELL) };
}

/** Compares two grey pictures of the same size cell by cell. */
export function compareFrames(previous: Uint8Array, current: Uint8Array, width: number, height: number): ChangeStep {
    const { columns, rows } = gridOf(width, height);
    const counts = new Uint16Array(columns * rows);

    for (let y = 0; y < height; y++) {
        const row = y * width;
        const cellRow = Math.floor(y / CELL) * columns;

        for (let x = 0; x < width; x++) {
            const index = row + x;

            if (Math.abs(previous[index] - current[index]) > PIXEL_NOISE) {
                counts[cellRow + Math.floor(x / CELL)]++;
            }
        }
    }

    let changed = 0;
    let box: ChangeStep["box"];

    for (let index = 0; index < counts.length; index++) {
        if (counts[index] < CELL_PIXELS) {
            continue;
        }

        changed++;
        const x = index % columns;
        const y = Math.floor(index / columns);
        box = box
            ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) }
            : { x0: x, y0: y, x1: x, y1: y };
    }

    return { changed, cells: columns * rows, ...(box ? { box } : {}) };
}

export interface WaitStretch {
    id: string;
    /** "still": nothing changed; "typing": a small part changed (typing, a spinner, a progress bar). */
    kind: "still" | "typing";
    fromUs: number;
    toUs: number;
    /** The proposed speed, 4 to 8: longer stretches play faster. */
    speed: number;
    /** Where the picture changed, as fractions of it from the top left; absent for a still stretch. */
    region?: { x: number; y: number; width: number; height: number };
}

/** 4x for a short stretch up to 8x for one of 16 s or more. */
export function proposedSpeed(lengthUs: number): number {
    return Math.min(8, Math.max(4, Math.round(lengthUs / 2_000_000)));
}

function stretchId(fromUs: number, toUs: number): string {
    return `w${createHash("sha1")
        .update(`${Math.round(fromUs / 1000)}-${Math.round(toUs / 1000)}`)
        .digest("hex")
        .slice(0, 8)}`;
}

/** Removes `holes` from `ranges`; both are [from, to) in microseconds. */
export function subtractRanges(
    ranges: ReadonlyArray<readonly [number, number]>,
    holes: ReadonlyArray<readonly [number, number]>
): Array<[number, number]> {
    let parts: Array<[number, number]> = ranges.map(([from, to]) => [from, to]);

    for (const [holeFrom, holeTo] of holes) {
        parts = parts.flatMap(([from, to]): Array<[number, number]> => {
            if (holeTo <= from || holeFrom >= to) {
                return [[from, to]];
            }

            return [
                ...(holeFrom > from ? [[from, holeFrom] as [number, number]] : []),
                ...(holeTo < to ? [[holeTo, to] as [number, number]] : []),
            ];
        });
    }

    return parts;
}

/**
 * The typing and waiting stretches of a movie from its change steps (step `i` compares picture `i` with `i + 1`,
 * `fps` pictures a second): runs where at most `maxArea` of the grid changed per step for at least `minUs`, without
 * the `busyUs` ranges (clicks, cursor moves, speech) and only inside `withinUs` (the kept parts at normal speed).
 * `keepUs` stays at normal speed at each end, so the change before and after it still plays.
 */
export function waitStretches(options: {
    steps: readonly ChangeStep[];
    fps: number;
    grid: { columns: number; rows: number };
    minUs: number;
    maxArea: number;
    keepUs?: number;
    busyUs?: ReadonlyArray<readonly [number, number]>;
    withinUs?: ReadonlyArray<readonly [number, number]>;
}): WaitStretch[] {
    const { steps, fps, grid, minUs, maxArea } = options;
    const keepUs = options.keepUs ?? 300_000;
    const stepUs = 1_000_000 / fps;
    const runs: Array<[number, number]> = [];
    let start: number | undefined;

    for (let index = 0; index <= steps.length; index++) {
        const quiet = index < steps.length && steps[index].changed / Math.max(1, steps[index].cells) <= maxArea;

        if (quiet && start === undefined) {
            start = index;
        } else if (!quiet && start !== undefined) {
            // Step i compares picture i with i + 1: the quiet run lasts from picture `start` to picture `index`.
            runs.push([Math.round(start * stepUs), Math.round(index * stepUs)]);
            start = undefined;
        }
    }

    let ranges = subtractRanges(runs, options.busyUs ?? []);

    if (options.withinUs) {
        const within = options.withinUs;
        ranges = ranges.flatMap(([from, to]) =>
            within.map(([a, b]): [number, number] => [Math.max(from, a), Math.min(to, b)]).filter(([a, b]) => b > a)
        );
    }

    return ranges
        .map(([from, to]): [number, number] => [from + keepUs, to - keepUs])
        .filter(([from, to]) => to - from >= minUs)
        .map(([fromUs, toUs]) => {
            const first = Math.floor(fromUs / stepUs);
            const last = Math.min(steps.length - 1, Math.ceil(toUs / stepUs));
            let box: ChangeStep["box"];

            for (let index = first; index <= last; index++) {
                const step = steps[index]?.box;

                if (step) {
                    box = box
                        ? {
                              x0: Math.min(box.x0, step.x0),
                              y0: Math.min(box.y0, step.y0),
                              x1: Math.max(box.x1, step.x1),
                              y1: Math.max(box.y1, step.y1),
                          }
                        : { ...step };
                }
            }

            const round = (value: number) => Math.round(value * 1000) / 1000;
            return {
                id: stretchId(fromUs, toUs),
                kind: box ? ("typing" as const) : ("still" as const),
                fromUs,
                toUs,
                speed: proposedSpeed(toUs - fromUs),
                ...(box
                    ? {
                          region: {
                              x: round(box.x0 / grid.columns),
                              y: round(box.y0 / grid.rows),
                              width: round((box.x1 - box.x0 + 1) / grid.columns),
                              height: round((box.y1 - box.y0 + 1) / grid.rows),
                          },
                      }
                    : {}),
            };
        });
}

/**
 * The change steps of a movie: ffmpeg writes a small grey copy at `WAIT_SAMPLE_FPS` to stdout, and each picture is
 * compared with the one before as it arrives (one picture is kept, never the whole movie).
 */
export async function measureChangeSteps(options: {
    video: string;
    width: number;
    height: number;
    timeoutMs?: number;
}): Promise<{ steps: ChangeStep[]; grid: { columns: number; rows: number }; fps: number }> {
    const width = WAIT_SAMPLE_WIDTH;
    const height = Math.max(2, Math.round((width * options.height) / options.width / 2) * 2);
    const frameBytes = width * height;
    const command = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-i",
        options.video,
        "-map",
        "0:v:0",
        "-vf",
        `fps=${WAIT_SAMPLE_FPS},scale=${width}:${height}:flags=area,format=gray`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ];
    log.debug({ command }, "measuring the picture's change steps");
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15 * 60_000);
    const steps: ChangeStep[] = [];
    let previous: Uint8Array | undefined;
    let pending = new Uint8Array(0);

    try {
        for await (const chunk of child.stdout) {
            const joined = new Uint8Array(pending.length + chunk.length);
            joined.set(pending);
            joined.set(chunk, pending.length);
            let offset = 0;

            while (joined.length - offset >= frameBytes) {
                const frame = joined.slice(offset, offset + frameBytes);
                offset += frameBytes;

                if (previous) {
                    steps.push(compareFrames(previous, frame, width, height));
                }

                previous = frame;
            }

            pending = joined.slice(offset);
        }

        const status = await child.exited;

        if (status !== 0) {
            const stderr = await new Response(child.stderr).text();
            throw new Error(`ffmpeg could not read ${options.video} (exit ${status}): ${stderr.trim().slice(-500)}`);
        }
    } finally {
        clearTimeout(timer);
    }

    log.debug({ video: options.video, steps: steps.length }, "change steps measured");
    return { steps, grid: gridOf(width, height), fps: WAIT_SAMPLE_FPS };
}

export const SPEED_BADGE_POSITIONS = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;

/**
 * The "⏩ 6x" badge over the picture while a sped-up part plays (a clip at 1.5x or more). Absent is no badge; the
 * `speedUpWaits` op turns it on, `autoSpeed` changes or hides it.
 */
export const autoSpeedSchema = z.object({
    badge: z.boolean().default(true),
    position: z.enum(SPEED_BADGE_POSITIONS).default("top-right"),
});
export type EditAutoSpeed = z.infer<typeof autoSpeedSchema>;
