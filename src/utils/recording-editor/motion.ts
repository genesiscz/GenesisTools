import { logger } from "@genesiscz/utils/logger";
import { sampleFpsFilter } from "./ffmpeg";
import type { Carried, FractionBox, MotionModel, TrackKey } from "./private-data";
import { type ChangeStep, maskCells } from "./waits";

const { log } = logger.scoped("recording-editor-motion");

/**
 * How the picture's content moves while a screen scrolls or slides, measured on small grey copies of the movie at its
 * own rate. Each picture is cut into blocks; each block is found again in the next picture (block matching), so every
 * block gets the shift its content made. A hidden part is then carried by the shift of the blocks under it, frame by
 * frame, also through pictures where OCR reads nothing (a fast scroll blurs the text).
 */

/** Pictures a second read for motion: the movie's own rate for a screen recording. */
export const MOTION_FPS = 30;
/** The grey copy's longer side in pixels. */
const MOTION_SIDE = 480;
/** One block's side in grey pixels. */
const BLOCK = 24;
/** The farthest a block is looked for between two pictures, in grey pixels (a fast flick at 30 pictures a second). */
const RADIUS = 96;
/** A block whose mean grey difference to the next picture stays under this did not move. */
const STILL_ERROR = 2.5;
/**
 * A change step moves the picture when more than this share of its grid changed: low, because a banner sliding in or
 * a short list scrolling is a small part of a whole screen.
 */
export const MOVING_SHARE = 0.005;
/** Pictures in a row a carried part keeps its last speed through when the shift under it is unknown. */
const MAX_BLIND_PAIRS = 3;
/** A block's state in a pair: 0 (left unset) its shift is unknown, it stood still, or it moved by its shift. */
const STILL = 1;
const MOVED = 2;
/** A block with less detail than this cannot be followed (an even background). */
const MIN_TEXTURE = 3;

/** The grey copy's size for a movie of `width` by `height`: the longer side MOTION_SIDE, both even. */
export function motionSize(width: number, height: number): { width: number; height: number } {
    const scale = Math.min(1, MOTION_SIDE / Math.max(width, height));
    const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
    return { width: even(width), height: even(height) };
}

/**
 * The block shifts of one stretch of a movie: picture `i` is at `fromUs + i * stepUs`, and pair `i` (picture i to
 * i + 1) holds for each block its shift in grey pixels and whether it could be measured.
 */
export interface MotionWindow {
    fromUs: number;
    stepUs: number;
    width: number;
    height: number;
    columns: number;
    rows: number;
    /** Pairs measured: one less than the pictures. */
    pairs: number;
    dx: Float32Array;
    dy: Float32Array;
    /** Per block: 0 its shift is unknown, 1 it stood still, 2 it moved by dx, dy. */
    ok: Uint8Array;
}

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** The blocks of a grey picture of `width` by `height`. */
function blockGrid(width: number, height: number): { columns: number; rows: number } {
    return { columns: Math.ceil(width / BLOCK), rows: Math.ceil(height / BLOCK) };
}

/**
 * The shift of each block from `previous` to `current`: (0, 0) where it did not change, else the best match of the block
 * in `current` near `guess` (the block's shift one pair before) and along the two axes through it, to a tenth of a
 * pixel (a parabola through the neighbours). A block it cannot find, or without detail, is not ok.
 */
export function blockShifts(options: {
    previous: Uint8Array;
    current: Uint8Array;
    width: number;
    height: number;
    guess?: { dx: Float32Array; dy: Float32Array; ok: Uint8Array };
}): { dx: Float32Array; dy: Float32Array; ok: Uint8Array } {
    const { previous, current, width, height, guess } = options;
    const { columns, rows } = blockGrid(width, height);
    const count = columns * rows;
    const dx = new Float32Array(count);
    const dy = new Float32Array(count);
    const ok = new Uint8Array(count);
    const textures = new Float32Array(count);
    const moved = new Uint8Array(count);

    /** The mean grey difference of block `index` shifted by (sx, sy); infinite when under half of it stays inside. */
    const cost = (index: number, sx: number, sy: number, every = 2): number => {
        const x0 = (index % columns) * BLOCK;
        const y0 = Math.floor(index / columns) * BLOCK;
        const x1 = Math.min(width, x0 + BLOCK);
        const y1 = Math.min(height, y0 + BLOCK);
        let total = 0;
        let inside = 0;
        let all = 0;

        for (let y = y0; y < y1; y += every) {
            const ty = y + sy;

            for (let x = x0; x < x1; x += every) {
                all++;
                const tx = x + sx;

                if (ty < 0 || ty >= height || tx < 0 || tx >= width) {
                    continue;
                }

                total += Math.abs(previous[y * width + x] - current[ty * width + tx]);
                inside++;
            }
        }

        return inside * 2 >= all ? total / inside : Number.POSITIVE_INFINITY;
    };

    /** The best shift of a block near each guess and along the two axes through the first, or undefined. */
    const solve = (index: number, guesses: ReadonlyArray<{ x: number; y: number }>) => {
        const tried = new Map<number, number>();
        const errorAt = (sx: number, sy: number): number => {
            const key = (sx + 512) * 1024 + (sy + 512);
            const known = tried.get(key);

            if (known !== undefined) {
                return known;
            }

            const value = cost(index, sx, sy);
            tried.set(key, value);
            return value;
        };
        const [first] = guesses;
        let best = { sx: 0, sy: 0, score: Number.POSITIVE_INFINITY, error: Number.POSITIVE_INFINITY };
        const consider = (sx: number, sy: number) => {
            const error = errorAt(sx, sy);
            // A small pull to the first guess: rows of a list look alike, and the nearest fit is the real one.
            const score = error + 0.03 * (Math.abs(sx - first.x) + Math.abs(sy - first.y));

            if (score < best.score) {
                best = { sx, sy, score, error };
            }
        };

        for (const guessed of guesses) {
            for (let sy = guessed.y - 3; sy <= guessed.y + 3; sy++) {
                for (let sx = guessed.x - 3; sx <= guessed.x + 3; sx++) {
                    consider(sx, sy);
                }
            }
        }

        const texture = textures[index];

        if (best.error > 0.3 * texture + 2) {
            for (let s = -RADIUS; s <= RADIUS; s++) {
                consider(first.x, s);
                consider(s, first.y);
            }

            const { sx, sy } = best;

            for (let ry = sy - 2; ry <= sy + 2; ry++) {
                for (let rx = sx - 2; rx <= sx + 2; rx++) {
                    consider(rx, ry);
                }
            }
        }

        // Found: clearly better than not moving, and close to the block's own detail.
        if (!(best.error < 0.6 * errorAt(0, 0)) || best.error > 0.6 * texture + 3) {
            return undefined;
        }

        const refine = (minus: number, here: number, plus: number): number => {
            const curve = minus - 2 * here + plus;
            return Number.isFinite(curve) && curve > 0
                ? Math.max(-0.5, Math.min(0.5, (minus - plus) / (2 * curve)))
                : 0;
        };
        return {
            x: best.sx + refine(errorAt(best.sx - 1, best.sy), best.error, errorAt(best.sx + 1, best.sy)),
            y: best.sy + refine(errorAt(best.sx, best.sy - 1), best.error, errorAt(best.sx, best.sy + 1)),
        };
    };

    for (let index = 0; index < count; index++) {
        const x0 = (index % columns) * BLOCK;
        const y0 = Math.floor(index / columns) * BLOCK;
        const x1 = Math.min(width, x0 + BLOCK);
        const y1 = Math.min(height, y0 + BLOCK);
        let sum = 0;
        let still = 0;
        let n = 0;

        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const at = y * width + x;
                sum += previous[at];
                still += Math.abs(previous[at] - current[at]);
                n++;
            }
        }

        const mean = sum / n;
        let texture = 0;

        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                texture += Math.abs(previous[y * width + x] - mean);
            }
        }

        textures[index] = texture / n;

        // An even block (a background) says nothing about motion: it matches anywhere, so it stays unknown.
        if (textures[index] < MIN_TEXTURE) {
            continue;
        }

        if (still / n < STILL_ERROR) {
            // Nearly the same picture: still, or a slow move (a smear creeping in) that a parabola through the errors
            // one pixel each way finds to a tenth of a pixel.
            // Every pixel: a sample of every second one sees an edge differently one pixel left and right.
            const here = cost(index, 0, 0, 1);
            const fraction = (minus: number, plus: number): number => {
                const curve = minus - 2 * here + plus;
                return Number.isFinite(curve) && curve > 0
                    ? Math.max(-0.5, Math.min(0.5, (minus - plus) / (2 * curve)))
                    : 0;
            };
            const fx = fraction(cost(index, -1, 0, 1), cost(index, 1, 0, 1));
            const fy = fraction(cost(index, 0, -1, 1), cost(index, 0, 1, 1));

            if (Math.abs(fx) >= 0.2 || Math.abs(fy) >= 0.2) {
                dx[index] = fx;
                dy[index] = fy;
                ok[index] = MOVED;
            } else {
                ok[index] = STILL;
            }

            continue;
        }

        moved[index] = 1;
        const own = guess?.ok[index]
            ? { x: Math.round(guess.dx[index]), y: Math.round(guess.dy[index]) }
            : { x: 0, y: 0 };
        const found = solve(index, [own]);

        if (found) {
            dx[index] = found.x;
            dy[index] = found.y;
            ok[index] = MOVED;
        }
    }

    // The content mostly moves as one (a list, a sheet): the blocks that moved and were found give a common shift,
    // which every block that moved is tried at again, so a block that looks like its neighbours still finds its way.
    const xs: number[] = [];
    const ys: number[] = [];

    for (let index = 0; index < count; index++) {
        if (ok[index] === MOVED) {
            xs.push(dx[index]);
            ys.push(dy[index]);
        }
    }

    if (xs.length >= 3) {
        const common = { x: Math.round(median(xs)), y: Math.round(median(ys)) };

        for (let index = 0; index < count; index++) {
            // A block that looked still can be a smear of moving text that matches itself: it moved when the common
            // shift fits it clearly better than standing still.
            const smear =
                ok[index] === STILL &&
                textures[index] >= MIN_TEXTURE &&
                (common.x !== 0 || common.y !== 0) &&
                cost(index, common.x, common.y) < 0.7 * cost(index, 0, 0);

            if (!moved[index] && !smear) {
                continue;
            }

            const own = ok[index] === MOVED ? { x: Math.round(dx[index]), y: Math.round(dy[index]) } : common;
            const found = solve(index, [common, own]);

            if (found) {
                dx[index] = found.x;
                dy[index] = found.y;
                ok[index] = MOVED;
            }
        }
    }

    return { dx, dy, ok };
}

/**
 * The block shifts of a movie from `fromUs` to `toUs`: ffmpeg writes grey copies at MOTION_FPS on the editor's time
 * base to stdout, and each picture is matched with the one before as it arrives (two pictures are kept, never more).
 */
export async function measureMotion(options: {
    video: string;
    sourceWidth: number;
    sourceHeight: number;
    fromUs: number;
    toUs: number;
    timeoutMs?: number;
}): Promise<MotionWindow> {
    const { width, height } = motionSize(options.sourceWidth, options.sourceHeight);
    const { columns, rows } = blockGrid(width, height);
    const stepUs = 1_000_000 / MOTION_FPS;
    const fromUs = Math.max(0, Math.floor(options.fromUs / stepUs) * stepUs);
    const frameBytes = width * height;
    const command = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        ...(fromUs > 0 ? ["-ss", (fromUs / 1_000_000).toFixed(6)] : []),
        "-i",
        options.video,
        "-t",
        (Math.max(stepUs * 2, options.toUs - fromUs + stepUs) / 1_000_000).toFixed(6),
        "-map",
        "0:v:0",
        "-vf",
        `${sampleFpsFilter(MOTION_FPS)},scale=${width}:${height}:flags=area,format=gray`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ];
    log.debug({ command }, "measuring the content's motion");
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 10 * 60_000);
    const dx: Float32Array[] = [];
    const dy: Float32Array[] = [];
    const ok: Uint8Array[] = [];
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
                    const last = ok.length - 1;
                    const shifts = blockShifts({
                        previous,
                        current: frame,
                        width,
                        height,
                        guess: last >= 0 ? { dx: dx[last], dy: dy[last], ok: ok[last] } : undefined,
                    });
                    dx.push(shifts.dx);
                    dy.push(shifts.dy);
                    ok.push(shifts.ok);
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

    const count = columns * rows;
    const join = <T extends Float32Array | Uint8Array>(parts: T[], make: (length: number) => T): T => {
        const all = make(parts.length * count);
        parts.forEach((part, index) => {
            all.set(part, index * count);
        });
        return all;
    };
    log.debug({ video: options.video, fromUs, pairs: ok.length }, "motion measured");
    return {
        fromUs,
        stepUs,
        width,
        height,
        columns,
        rows,
        pairs: ok.length,
        dx: join(dx, (length) => new Float32Array(length)),
        dy: join(dy, (length) => new Float32Array(length)),
        ok: join(ok, (length) => new Uint8Array(length)),
    };
}

/** A window as JSON (the arrays as base64), for the analysis cache. */
export function motionWindowToJson(window: MotionWindow): Record<string, number | string> {
    const base64 = (array: Float32Array | Uint8Array) =>
        Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString("base64");
    return {
        fromUs: window.fromUs,
        stepUs: window.stepUs,
        width: window.width,
        height: window.height,
        columns: window.columns,
        rows: window.rows,
        pairs: window.pairs,
        dx: base64(window.dx),
        dy: base64(window.dy),
        ok: base64(window.ok),
    };
}

export function motionWindowFromJson(raw: {
    fromUs: number;
    stepUs: number;
    width: number;
    height: number;
    columns: number;
    rows: number;
    pairs: number;
    dx: string;
    dy: string;
    ok: string;
}): MotionWindow {
    const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
    const floats = (text: string) => {
        const data = bytes(text);
        return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    };
    return { ...raw, dx: floats(raw.dx), dy: floats(raw.dy), ok: bytes(raw.ok) };
}

/**
 * The motion of a movie as a hidden part needs it: block shifts where the picture moved (windows), and the change steps
 * of the whole movie, which say where it moved at all. Between windows the picture is taken as still.
 */
export class MotionField implements MotionModel {
    private readonly windows: MotionWindow[];

    constructor(
        windows: readonly MotionWindow[],
        private readonly steps: { steps: readonly ChangeStep[]; fps: number; grid: { columns: number; rows: number } }
    ) {
        this.windows = [...windows].sort((a, b) => a.fromUs - b.fromUs);
    }

    private movingStep(index: number): boolean {
        const step = this.steps.steps[index];
        return Boolean(step && (step.dy || step.changed / Math.max(1, step.cells) > MOVING_SHARE));
    }

    moving(fromUs: number, toUs: number): boolean {
        const stepUs = 1_000_000 / this.steps.fps;
        const low = Math.min(fromUs, toUs);
        const high = Math.max(fromUs, toUs);

        for (
            let index = Math.floor(low / stepUs);
            index < Math.max(Math.ceil(high / stepUs), Math.floor(low / stepUs) + 1);
            index++
        ) {
            if (this.movingStep(index)) {
                return true;
            }
        }

        return false;
    }

    movingArea(fromUs: number, toUs: number): FractionBox | undefined {
        const stepUs = 1_000_000 / this.steps.fps;
        const { columns, rows } = this.steps.grid;
        let area: { x0: number; y0: number; x1: number; y1: number } | undefined;

        for (
            let index = Math.floor(Math.min(fromUs, toUs) / stepUs);
            index <= Math.ceil(Math.max(fromUs, toUs) / stepUs);
            index++
        ) {
            const box = this.steps.steps[index]?.box;

            if (box && this.movingStep(index)) {
                area = area
                    ? {
                          x0: Math.min(area.x0, box.x0),
                          y0: Math.min(area.y0, box.y0),
                          x1: Math.max(area.x1, box.x1),
                          y1: Math.max(area.y1, box.y1),
                      }
                    : { ...box };
            }
        }

        return area
            ? {
                  x: area.x0 / columns,
                  y: area.y0 / rows,
                  width: (area.x1 + 1 - area.x0) / columns,
                  height: (area.y1 + 1 - area.y0) / rows,
              }
            : undefined;
    }

    /** Where the picture under `box` stops changing from `atUs` on in `direction` (the change steps' cells). */
    changeEdge(box: FractionBox, atUs: number, direction: 1 | -1, limitUs: number): number {
        const stepUs = 1_000_000 / this.steps.fps;
        const { columns, rows } = this.steps.grid;
        const c0 = Math.max(0, Math.floor(box.x * columns));
        const c1 = Math.min(columns - 1, Math.floor((box.x + box.width) * columns));
        const r0 = Math.max(0, Math.floor(box.y * rows));
        const r1 = Math.min(rows - 1, Math.floor((box.y + box.height) * rows));
        const changedUnder = (index: number): boolean => {
            const cells = maskCells(this.steps.steps[index]?.mask);

            for (let row = r0; row <= r1; row++) {
                for (let column = c0; column <= c1; column++) {
                    if (cells.has(row * columns + column)) {
                        return true;
                    }
                }
            }

            return false;
        };
        let index = direction > 0 ? Math.floor(atUs / stepUs) : Math.ceil(atUs / stepUs) - 1;

        while (index >= 0 && changedUnder(index)) {
            const edge = direction > 0 ? (index + 1) * stepUs : index * stepUs;

            if (Math.abs(edge - atUs) >= limitUs) {
                return atUs + direction * limitUs;
            }

            index += direction;
        }

        const edge = direction > 0 ? index * stepUs : (index + 1) * stepUs;
        return direction > 0 ? Math.max(atUs, edge) : Math.min(atUs, edge);
    }

    /** The window that measured the pair starting at picture time `atUs` (forward) or ending at it (backward). */
    private windowAt(atUs: number, direction: 1 | -1): MotionWindow | undefined {
        return this.windows.find((window) => {
            const endUs = window.fromUs + window.pairs * window.stepUs;
            return direction > 0
                ? atUs >= window.fromUs - window.stepUs / 2 && atUs < endUs - window.stepUs / 2
                : atUs > window.fromUs + window.stepUs / 2 && atUs <= endUs + window.stepUs / 2;
        });
    }

    /** The shift of the content under `box` in pair `pair` of `window`, in fractions of the picture; undefined: unknown. */
    private shiftUnder(
        window: MotionWindow,
        pair: number,
        box: FractionBox
    ): { x: number; y: number; direct: boolean } | undefined {
        const { columns, rows, width, height } = window;
        const c0 = Math.max(0, Math.floor((box.x * width) / BLOCK));
        const c1 = Math.min(columns - 1, Math.floor(((box.x + box.width) * width - 0.001) / BLOCK));
        const r0 = Math.max(0, Math.floor((box.y * height) / BLOCK));
        const r1 = Math.min(rows - 1, Math.floor(((box.y + box.height) * height - 0.001) / BLOCK));

        if (c0 > c1 || r0 > r1) {
            return undefined;
        }

        const base = pair * columns * rows;
        /** The blocks of rows r0..r1 and columns c0..c1 that moved, and how many stood still. */
        const look = (rowFrom: number, rowTo: number, columnFrom: number, columnTo: number) => {
            const xs: number[] = [];
            const ys: number[] = [];
            let still = 0;

            for (let row = Math.max(0, rowFrom); row <= Math.min(rows - 1, rowTo); row++) {
                for (let column = Math.max(0, columnFrom); column <= Math.min(columns - 1, columnTo); column++) {
                    const index = base + row * columns + column;

                    if (window.ok[index] === MOVED) {
                        xs.push(window.dx[index]);
                        ys.push(window.dy[index]);
                    } else if (window.ok[index] === STILL) {
                        still++;
                    }
                }
            }

            return { xs, ys, still };
        };
        // What moved under the part decides; a smear of moving text can look still, so moving blocks win. With none
        // under it (a blank stretch of the line), its neighbours one block around decide.
        // Last, the blocks of its rows across the picture: a list or a banner moves as one band.
        const reaches: Array<[number, number, number, number]> = [
            [r0, r1, c0, c1],
            [r0 - 1, r1 + 1, c0 - 1, c1 + 1],
            [r0 - 1, r1 + 1, 0, columns - 1],
        ];

        for (const [reach, [rowFrom, rowTo, columnFrom, columnTo]] of reaches.entries()) {
            const direct = reach === 0;
            const found = look(rowFrom, rowTo, columnFrom, columnTo);

            if (found.xs.length > 0 && found.xs.length * 2 >= found.still) {
                return { x: median(found.xs) / width, y: median(found.ys) / height, direct };
            }

            if (found.still > 0) {
                return { x: 0, y: 0, direct: true };
            }
        }

        return undefined;
    }

    carry(box: FractionBox, fromUs: number, toUs: number, options: { untilStill?: boolean } = {}): Carried {
        const direction: 1 | -1 = toUs >= fromUs ? 1 : -1;
        const keys: TrackKey[] = [];
        let at = fromUs;
        let place: FractionBox = { x: box.x, y: box.y, width: box.width, height: box.height };
        let quiet = 0;
        let blind = 0;
        let lastShift: { x: number; y: number } | undefined;

        const done = (end: Carried["end"]): Carried => ({ keys, reachedUs: at, box: place, end });

        while (direction > 0 ? at < toUs : at > toUs) {
            const window = this.windowAt(at, direction);

            if (!window) {
                // Not measured: the picture is still here, or it moves where nobody looked.
                const next = this.windows
                    .map((one) => (direction > 0 ? one.fromUs : one.fromUs + one.pairs * one.stepUs))
                    .filter((edge) => (direction > 0 ? edge > at + 1 : edge < at - 1))
                    .sort((a, b) => direction * (a - b))[0];
                const until = next === undefined ? toUs : direction > 0 ? Math.min(next, toUs) : Math.max(next, toUs);

                if (this.moving(at, until)) {
                    return done("lost");
                }

                if (options.untilStill) {
                    return done("still");
                }

                at = until;
                continue;
            }

            const pair =
                direction > 0
                    ? Math.round((at - window.fromUs) / window.stepUs)
                    : Math.round((at - window.fromUs) / window.stepUs) - 1;
            const first = this.shiftUnder(window, pair, place);
            // Backward, the content under the part came from where it was one shift earlier.
            const measured =
                direction > 0 || !first
                    ? first
                    : (this.shiftUnder(window, pair, { ...place, x: place.x - first.x, y: place.y - first.y }) ??
                      first);
            // A picture or two without a known shift (a blank flash, a frame the encoder smeared) keeps the speed.
            // A shift read from the neighbours, not from under the part, is a guess too: a few in a row only.
            blind = measured?.direct ? 0 : blind + 1;
            const shift = blind > MAX_BLIND_PAIRS ? undefined : (measured ?? lastShift);

            if (!shift) {
                return done("lost");
            }

            lastShift = shift;

            place = { ...place, x: place.x + direction * shift.x, y: place.y + direction * shift.y };
            at = window.fromUs + (pair + (direction > 0 ? 1 : 0)) * window.stepUs;
            keys.push({ atUs: Math.round(at), ...place });
            const centre = { x: place.x + place.width / 2, y: place.y + place.height / 2 };

            if (centre.x < 0 || centre.x > 1 || centre.y < 0 || centre.y > 1) {
                return done("left");
            }

            quiet = Math.abs(shift.x) * window.width < 0.1 && Math.abs(shift.y) * window.height < 0.1 ? quiet + 1 : 0;

            if (options.untilStill && quiet >= 3) {
                return done("still");
            }
        }

        return done("reached");
    }
}
