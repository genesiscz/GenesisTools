import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { recognizeTextBoxesQueued } from "@genesiscz/utils/macos/ocr-queue";
import {
    type AnalysisCacheRequest,
    cachedAnalysis,
    readAnalysis,
} from "@genesiscz/utils/recording-editor/analysis-cache";
import {
    anchorTimeUs,
    type EventAnchor,
    type MovieEvent,
    type MovieEventKind,
    movieEvents,
    nearestEvent,
    type Tap,
} from "@genesiscz/utils/recording-editor/events";
import { sampleFpsFilter } from "@genesiscz/utils/recording-editor/ffmpeg";
import {
    MOTION_FPS,
    MOVING_SHARE,
    MotionField,
    type MotionWindow,
    measureMotion,
    motionWindowFromJson,
    motionWindowToJson,
} from "@genesiscz/utils/recording-editor/motion";
import { cardsLeadUs } from "@genesiscz/utils/recording-editor/overlays";
import { type TimeValue, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import {
    edgeFragments,
    type FractionBox,
    type LineMatcher,
    type PrivateHit,
    privateMatcher,
    type ScreenTextFrame,
    type TextMatcherOptions,
    textHits,
    textMatcher,
    unmatchedQueries,
} from "@genesiscz/utils/recording-editor/private-data";
import {
    boundaryWindows,
    type EditOp,
    type EditProject,
    exportToOutputUs,
    leakFixOps,
    leakSourceBox,
    leakSourceKeys,
    outputDurationUs,
    outputTimeOf,
    readCursorTrack,
    sourceTimeOf,
    transcriptCachePath,
} from "@genesiscz/utils/recording-editor/project";
import { refineSceneTimes } from "@genesiscz/utils/recording-editor/scene-times";
import {
    type ChangeStep,
    fixedAreas,
    measureChangeSteps,
    WAIT_SAMPLE_FPS,
    type WaitStretch,
    waitStretches,
} from "@genesiscz/utils/recording-editor/waits";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";
import { exportAs, exportProgressPrinter, openProject, readTranscriptSegments } from "./edit";
import { boxInProxy, proxyCanvas, readDisplayPlan } from "./proxy";
import { displaySizes, frameTexts, visibleSpans } from "./screen-search";

const { log } = logger.scoped("recorder-fx-analysis");

/**
 * The analysis behind three editor effects: the screen text of a movie (for private data), and the picture's change
 * steps (for typing and waiting speed-ups). Both are slow, so each is cached under the movie's content key in one
 * shared folder (analysis-cache.ts), and every copy of the same movie reuses it. The screen text is read with Vision on
 * this Mac (darwinkit); nothing is sent anywhere.
 */

/** Where an analysis was cached before R8 8: `<folder>/<name>.json` for a recording folder, `<movie>.<name>.json` else. */
function cachePath(video: string, name: string): string {
    const folder = dirname(video);
    return existsSync(join(folder, "recording.json"))
        ? join(folder, `${name}.json`)
        : join(folder, `${basename(video, extname(video))}.${name}.json`);
}

/** The key of a cache from before R8 8: the movie file's size and time, then how it was read. */
function movieKey(video: string, extra: string): string {
    const stat = statSync(video);
    return `${stat.size}:${Math.round(stat.mtimeMs)}:${extra}`;
}

/** The shared cache request of the analysis `name` read as `key`, with the old cache beside the movie to move over. */
function analysisOf<T>(video: string, name: string, key: string, schema: z.ZodType<T>): AnalysisCacheRequest<T> {
    return { video, name, key, schema, legacy: { path: cachePath(video, name), key: movieKey(video, key) } };
}

const boxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const screenFramesSchema = z.array(
    z.object({
        atUs: z.number(),
        untilUs: z.number(),
        lines: z.array(boxSchema.extend({ text: z.string() })),
    })
);

/** The recording folder whose frames carry OCR (a frames recording or a meeting), or undefined for a movie. */
function framesFolderOf(project: EditProject): string | undefined {
    const folder = dirname(project.source.video);
    const manifest = existsSync(join(folder, "recording.json")) ? readRecordingManifest(folder) : undefined;
    return manifest && manifest.frames.length > 0 ? folder : undefined;
}

/** A frames recording's screen text: the OCR its frames kept, placed over its proxy movie as find-screen places it. */
function framesScreenText(folder: string): ScreenTextFrame[] {
    const manifest = readRecordingManifest(folder);

    if (!manifest) {
        return [];
    }

    const frames = [...manifest.frames].sort((a, b) => a.atMs - b.atMs);
    const texts = frameTexts(
        folder,
        frames.map((frame) => frame.file),
        "",
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
    const out: ScreenTextFrame[] = [];

    for (const [index, frame] of frames.entries()) {
        const read = texts.get(frame.file);
        const size = sizes.get(frame.displayId);

        if (!read || !size) {
            continue;
        }

        const lines = read.blocks.map((block) => ({
            text: block.text,
            ...boxInProxy(
                {
                    x: block.bounds.x,
                    y: 1 - block.bounds.y - block.bounds.height,
                    width: block.bounds.width,
                    height: block.bounds.height,
                },
                size,
                canvas
            ),
        }));
        const next = frames.slice(index + 1).find((later) => later.displayId === frame.displayId);
        const spans =
            visible && frame.displayId !== undefined
                ? (visible.get(frame.file) ?? [])
                : [{ fromUs: frame.atMs * 1000, toUs: (next?.atMs ?? lastMs + 2000) * 1000 }];

        for (const span of spans) {
            out.push({ atUs: span.fromUs, untilUs: span.toUs, lines });
        }
    }

    return out;
}

/** Seconds between the movie frames OCR reads: 1, more for a long movie so a scan reads at most 900 frames. */
export function screenTextEverySeconds(durationUs: number): number {
    return Math.max(1, Math.ceil(durationUs / 1_000_000 / 900));
}

/**
 * A movie's screen text: one frame every `everySec` (ffmpeg), each read with Vision. A frame whose picture is the same
 * file as the one before reuses its text, so a still stretch costs one read.
 */
/**
 * Vision OCR of a movie's frames from `fromUs` to `toUs`, `fps` a second (ffmpeg writes them, Vision reads them on
 * this Mac). A frame whose picture is the same file as the one before reuses its text, so a still stretch costs one
 * read. Each frame lasts until the next.
 */
export async function ocrVideo(options: {
    video: string;
    fromUs?: number;
    toUs: number;
    fps: number;
    /** Called after each frame is read (done of total). */
    onFrame?: (done: number, total: number) => void;
}): Promise<ScreenTextFrame[]> {
    const fromUs = options.fromUs ?? 0;
    const stepUs = 1_000_000 / options.fps;
    const folder = mkdtempSync(join(tmpdir(), "gt-screen-text-"));

    try {
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                ...(fromUs > 0 ? ["-ss", String(fromUs / 1_000_000)] : []),
                "-i",
                options.video,
                "-t",
                String(Math.max(0.05, (options.toUs - fromUs) / 1_000_000)),
                "-map",
                "0:v:0",
                "-vf",
                sampleFpsFilter(options.fps),
                "-start_number",
                "0",
                join(folder, "%06d.png"),
            ],
            timeoutMs: 20 * 60_000,
        });
        const files = readdirSync(folder)
            .filter((file) => file.endsWith(".png"))
            .sort();
        const frames: ScreenTextFrame[] = [];
        let previousDigest = "";
        let previousLines: ScreenTextFrame["lines"] = [];

        for (const [index, file] of files.entries()) {
            const path = join(folder, file);
            const digest = createHash("sha1").update(readFileSync(path)).digest("hex");
            const atUs = Math.round(fromUs + Number(file.replace(".png", "")) * stepUs);

            if (digest !== previousDigest) {
                // R6 4: one Vision read at a time on this Mac, retried once with a longer deadline.
                const read = await recognizeTextBoxesQueued(path, {
                    fastFallback: false,
                    what: `the frame at ${(atUs / 1_000_000).toFixed(2)} s of ${basename(options.video)}`,
                });
                previousLines = read.lines.map((line) => ({
                    text: line.text,
                    x: line.x / read.width,
                    y: line.y / read.height,
                    width: line.width / read.width,
                    height: line.height / read.height,
                }));
                previousDigest = digest;
            }

            frames.push({ atUs, untilUs: Math.min(options.toUs, Math.round(atUs + stepUs)), lines: previousLines });
            options.onFrame?.(index + 1, files.length);
        }

        log.debug(
            { video: options.video, fromUs, toUs: options.toUs, fps: options.fps, frames: frames.length },
            "frames read with Vision"
        );
        return frames;
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}

/** One movie frame every `screenTextEverySeconds`, read with Vision. */
function movieScreenText(project: EditProject): Promise<ScreenTextFrame[]> {
    return ocrVideo({
        video: project.source.video,
        toUs: project.source.durationUs,
        fps: 1 / screenTextEverySeconds(project.source.durationUs),
    });
}

// R7 10 zoom edge text
/**
 * The screen text read so far, never a new OCR: a frames recording's own, else the movie's cache when a findText or
 * hideText made it. check() reads it to find a zoom that cuts text; undefined when nothing was read yet.
 */
export function cachedScreenText(project: EditProject): ScreenTextFrame[] | undefined {
    const framesFolder = framesFolderOf(project);

    if (framesFolder) {
        return framesScreenText(framesFolder);
    }

    const video = project.source.video;

    if (!existsSync(video)) {
        return undefined;
    }

    return readAnalysis(analysisOf(video, "screen-text", screenTextKey(project), screenFramesSchema));
}

/** How the screen text is read. editor-time: sampled on the editor time base (sampleFpsFilter). */
function screenTextKey(project: EditProject): string {
    return `every=${screenTextEverySeconds(project.source.durationUs)},editor-time`;
}

/**
 * The movie's screen text as frames of OCR lines over its picture. A frames recording's own OCR, else a Vision read
 * of sampled movie frames, cached once per movie content (analysis-cache.ts).
 */
export async function screenTextOf(
    project: EditProject
): Promise<{ frames: ScreenTextFrame[]; source: "frames" | "movie"; cached: boolean }> {
    const framesFolder = framesFolderOf(project);

    if (framesFolder) {
        return { frames: framesScreenText(framesFolder), source: "frames", cached: true };
    }

    const video = project.source.video;

    if (!existsSync(video)) {
        throw new Error(`the movie ${video} is not there, so its screen text cannot be read`);
    }

    let read = false;
    const frames = await cachedAnalysis({
        ...analysisOf(video, "screen-text", screenTextKey(project), screenFramesSchema),
        compute: async () => {
            const started = Date.now();
            const movieFrames = await movieScreenText(project);
            log.debug(
                { video, frames: movieFrames.length, ms: Date.now() - started },
                "movie screen text read with Vision"
            );
            read = true;
            return movieFrames;
        },
    });
    return { frames, source: "movie", cached: !read };
}

/** Frames a second around a hit's edges and while it moves: a scrolling line is placed every 0.2 s. */
const DENSE_FPS = 5;

const denseSchema = z.record(z.string(), screenFramesSchema.element.shape.lines);

/**
 * Vision OCR of the movie at `DENSE_FPS` inside `windows` (source microseconds), cached by frame time in
 * `screen-text-dense.json`, so a second search reads only the frames it has not read yet. `twice` (R8 2) reads the
 * frames half way between those too, at twice the rate.
 */
async function denseScreenText(
    project: EditProject,
    windows: ReadonlyArray<[number, number]>,
    { twice = false }: { twice?: boolean } = {}
): Promise<ScreenTextFrame[]> {
    const video = project.source.video;
    const stepUs = 1_000_000 / DENSE_FPS;
    let read = false;

    const times = new Set<number>();

    for (const [fromUs, toUs] of windows) {
        // Each grid is read on its own, so the half-way frames of a window read before at DENSE_FPS add only themselves.
        for (const offset of twice ? [0, stepUs / 2] : [0]) {
            const start = Math.floor((fromUs - offset) / stepUs) * stepUs + offset;
            const grid: number[] = [];

            for (let atUs = start; atUs < toUs; atUs += stepUs) {
                grid.push(Math.round(atUs));
            }

            if (grid.some((atUs) => !cache[String(atUs)])) {
                for (const frame of await ocrVideo({ video, fromUs: start, toUs, fps: DENSE_FPS })) {
                    const atUs = Math.round(Math.round((frame.atUs - start) / stepUs) * stepUs + start);
                    cache[String(atUs)] = frame.lines;
                }

                read = true;
            }

            for (const atUs of grid) {
                times.add(atUs);
            }
        }
    }

    if (read) {
        writeCache(path, key, cache);
    }

    // A time ffmpeg gave no picture for (past the last frame) is not a frame that shows nothing.
    const ordered = [...times].filter((atUs) => cache[String(atUs)]).sort((a, b) => a - b);
    return ordered.map((atUs, index) => ({
        atUs,
        untilUs: Math.min(project.source.durationUs, ordered[index + 1] ?? atUs + stepUs, atUs + stepUs),
        lines: cache[String(atUs)] ?? [],
    }));
}

/** The parts of `window` that none of `taken` (joined, in order) covers. */
function windowsMinus(window: [number, number], taken: ReadonlyArray<[number, number]>): Array<[number, number]> {
    const left: Array<[number, number]> = [];
    let from = window[0];

    for (const [start, end] of taken) {
        if (end <= from || start >= window[1]) {
            continue;
        }

        if (start > from) {
            left.push([from, start]);
        }

        from = Math.max(from, end);
    }

    if (from < window[1]) {
        left.push([from, window[1]]);
    }

    return left;
}

/** Joins overlapping [from, to) ranges. */
function mergeWindows(ranges: Array<[number, number]>): Array<[number, number]> {
    const merged: Array<[number, number]> = [];

    for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
        const last = merged.at(-1);

        if (last && from <= last[1]) {
            last[1] = Math.max(last[1], to);
        } else {
            merged.push([from, to]);
        }
    }

    return merged;
}

/** How far from a sample that shows the text the picture's motion is measured: a hit is carried at most 2 s past it. */
const MOTION_REACH_US = 3_000_000;

/**
 * The stretches where the picture moves (more than MOVING_SHARE of the grid changes between two change-step pictures),
 * a step wider each way, that lie within MOTION_REACH_US of a sample showing the text.
 */
function movingStretches(
    { steps, fps }: { steps: readonly ChangeStep[]; fps: number },
    seenUs: readonly number[]
): Array<[number, number]> {
    const stepUs = 1_000_000 / fps;
    const stretches: Array<[number, number]> = [];

    for (const [index, step] of steps.entries()) {
        if (step.dy || step.changed / Math.max(1, step.cells) > MOVING_SHARE) {
            const from = Math.max(0, (index - 1) * stepUs);
            const to = (index + 2) * stepUs;

            if (seenUs.some((at) => at > from - MOTION_REACH_US && at < to + MOTION_REACH_US)) {
                stretches.push([from, to]);
            }
        }
    }

    return mergeWindows(stretches);
}

const motionWindowSchema = z.object({
    fromUs: z.number(),
    stepUs: z.number(),
    width: z.number(),
    height: z.number(),
    columns: z.number(),
    rows: z.number(),
    pairs: z.number(),
    dx: z.string(),
    dy: z.string(),
    ok: z.string(),
});
const motionCacheSchema = z.record(z.string(), motionWindowSchema);

/** The content's motion in each stretch (motion.ts), cached by stretch in `motion.json` beside the edit. */
async function motionWindows(
    project: EditProject,
    stretches: ReadonlyArray<[number, number]>
): Promise<MotionWindow[]> {
    const video = project.source.video;
    const names = stretches.map(([fromUs, toUs]) => `${Math.round(fromUs)}-${Math.round(toUs)}`);
    const cache = await cachedAnalysis({
        ...analysisOf(video, "motion", `motion=${MOTION_FPS},v2`, motionCacheSchema),
        complete: (cached) => names.every((name) => cached[name]),
        compute: async (cached) => {
            const known = { ...(cached ?? {}) };

            for (const [index, [fromUs, toUs]] of stretches.entries()) {
                const name = names[index];

                if (known[name]) {
                    continue;
                }

                const window = await measureMotion({
                    video,
                    sourceWidth: project.source.width,
                    sourceHeight: project.source.height,
                    fromUs,
                    toUs,
                });
                known[name] = motionWindowSchema.parse(motionWindowToJson(window));
            }

            return known;
        },
    });

    return names.map((name) => motionWindowFromJson(cache[name]));
}

export interface TrackOptions {
    exclude?: readonly FractionBox[];
    /** Leave visible what stays still while the content under it moves. */
    excludeFixed?: boolean;
    /** R8 7: gets every frame of screen text the hits were found in. */
    onRead?: (frames: readonly ScreenTextFrame[]) => void;
    /** R8 6: read the screen only between these source microseconds (a findText or hideText with from/to). */
    scan?: { fromUs: number; toUs: number };
}

/** R8 6: how far past a from/to the screen is read, so a text that shows across the edge is followed into it. */
const SCAN_MARGIN_US = 1_000_000;

/** R8 6: the part of the movie a from/to (source seconds) asks to read, with SCAN_MARGIN_US each side; all without. */
export function scanOf(from?: TimeValue, to?: TimeValue): { fromUs: number; toUs: number } | undefined {
    if (from === undefined && to === undefined) {
        return undefined;
    }

    return {
        fromUs: from === undefined ? 0 : Math.max(0, timeToUs(from) - SCAN_MARGIN_US),
        toUs: to === undefined ? Number.POSITIVE_INFINITY : timeToUs(to) + SCAN_MARGIN_US,
    };
}

/**
 * R8 6: the screen text of `scan` only: the whole movie's when it was read before (a frames recording's own, or the
 * cache), else a Vision read of that range alone at the same rate, so a 2 s findText reads 4 s of the movie, not all.
 */
async function screenTextIn(
    project: EditProject,
    scan: { fromUs: number; toUs: number } | undefined
): Promise<{ frames: ScreenTextFrame[]; source: "frames" | "movie" }> {
    if (!scan) {
        return screenTextOf(project);
    }

    const inside = (frame: ScreenTextFrame) => frame.untilUs > scan.fromUs && frame.atUs < scan.toUs;
    const whole = cachedScreenText(project);

    if (whole) {
        return { frames: whole.filter(inside), source: framesFolderOf(project) ? "frames" : "movie" };
    }

    if (!existsSync(project.source.video)) {
        throw new Error(`the movie ${project.source.video} is not there, so its screen text cannot be read`);
    }

    const toUs = Math.min(project.source.durationUs, scan.toUs);
    log.debug({ video: project.source.video, fromUs: scan.fromUs, toUs }, "screen text of a range only");
    const frames = await ocrVideo({
        video: project.source.video,
        fromUs: scan.fromUs,
        toUs,
        fps: 1 / screenTextEverySeconds(project.source.durationUs),
    });
    return { frames, source: "movie" };
}

/**
 * Where `matcher` finds text on the screen, tracked over time. A movie is read once a second (cached), then again
 * five times a second around each hit's first and last second and wherever the picture moves while it shows, so a
 * hit starts and ends within 0.2 s of when the text shows and follows a scroll. `excludeFixed` adds, to a hit that
 * moved, the areas that stayed still meanwhile (a toast over the scroll), which its hidden part leaves visible.
 */
export async function trackedHits(
    project: EditProject,
    matcher: LineMatcher,
    options: TrackOptions = {}
): Promise<PrivateHit[]> {
    const { frames: coarse, source } = await screenTextIn(project, options.scan);
    const exclude = options.exclude ?? [];

    if (source === "frames") {
        options.onRead?.(coarse);
        return textHits(coarse, matcher, { exclude });
    }

    const { steps, fps, grid } = await changeStepsOf(project);
    const stepUs = 1_000_000 / fps;
    const matches = (frame: ScreenTextFrame | undefined) =>
        frame?.lines.some((line) => matcher(line.text).length > 0) ?? false;
    const moves = (fromUs: number, toUs: number) =>
        steps
            .slice(Math.floor(fromUs / stepUs), Math.ceil(toUs / stepUs))
            .some((step) => step.changed / Math.max(1, step.cells) > 0.02);
    const windows: Array<[number, number]> = [];

    for (const [index, frame] of coarse.entries()) {
        if (!matches(frame)) {
            continue;
        }

        const before = coarse[index - 1];
        const after = coarse[index + 1];

        if (!matches(before)) {
            windows.push([before?.atUs ?? frame.atUs, frame.untilUs]);
        }

        if (!matches(after)) {
            windows.push([frame.atUs, after?.untilUs ?? frame.untilUs]);
        }

        if (moves(frame.atUs, frame.untilUs)) {
            windows.push([frame.atUs, frame.untilUs]);
        }
    }

    const follow = async (read: Array<[number, number]>, fast: Array<[number, number]> = []) => {
        const byTime = new Map<number, ScreenTextFrame>();

        for (const frame of [
            ...(await denseScreenText(project, read)),
            ...(await denseScreenText(project, fast, { twice: true })),
        ]) {
            byTime.set(frame.atUs, frame);
        }

        const ordered = [...byTime.values()].sort((a, b) => a.atUs - b.atUs);
        const dense = ordered.map((frame, index) => ({
            ...frame,
            untilUs: Math.min(frame.untilUs, ordered[index + 1]?.atUs ?? frame.untilUs),
        }));
        const outside = coarse.filter((frame) => !read.some(([from, to]) => frame.atUs >= from && frame.atUs < to));
        const seen = [...outside, ...dense].filter((frame) => matches(frame)).map((frame) => frame.atUs);
        const motion = new MotionField(await motionWindows(project, movingStretches({ steps, fps }, seen)), {
            steps,
            fps,
            grid,
        });
        options.onRead?.([...outside, ...dense]);
        return textHits([...outside, ...dense], matcher, { exclude, motion });
    };
    const merged = mergeWindows(windows);
    let hits = await follow(merged);
    // R8 2: a hit that moves is read at DENSE_FPS over its whole life, not only around the coarse samples that showed
    // it: between those the motion alone carried it, and a line that slid under a bar or read short went off its part.
    const moving = mergeWindows(
        hits.filter((hit) => (hit.follow?.movingUs ?? 0) > 0).map((hit): [number, number] => [hit.fromUs, hit.toUs])
    );
    const more = moving.flatMap((window) => windowsMinus(window, merged));

    // A row that slides in at an edge during a scroll can read short or run into its neighbour on every 0.2 s frame
    // (the bottom row under a tab bar); a hit that moves is read at 10 frames a second.
    if (moving.length > 0) {
        log.debug({ windows: more.length, moving: moving.length }, "trackedHits: a second read over the moving hits");
        hits = await follow(mergeWindows([...merged, ...more]), moving);
    }

    if (!options.excludeFixed) {
        return hits;
    }

    return hits.map((hit) => {
        if (hit.keys.length < 2) {
            return hit;
        }

        const centres = hit.keys.map((key) => ({ x: key.x + key.width / 2, y: key.y + key.height / 2 }));
        const areas = fixedAreas({ steps, fps, grid, fromUs: hit.fromUs, toUs: hit.toUs }).filter(
            (area) =>
                // The text itself standing still is not something to leave visible.
                !centres.some(
                    (centre) =>
                        centre.x >= area.x &&
                        centre.x <= area.x + area.width &&
                        centre.y >= area.y &&
                        centre.y <= area.y + area.height
                ) &&
                area.x < hit.box.x + hit.box.width &&
                area.x + area.width > hit.box.x &&
                area.y < hit.box.y + hit.box.height &&
                area.y + area.height > hit.box.y
        );
        // Only the part inside the hit's path matters to its hidden part.
        const clipped = areas
            .map((area) => {
                const x = Math.max(area.x, hit.box.x);
                const y = Math.max(area.y, hit.box.y);
                const round = (value: number) => Math.round(value * 10_000) / 10_000;
                return {
                    x: round(x),
                    y: round(y),
                    width: round(Math.min(area.x + area.width, hit.box.x + hit.box.width) - x),
                    height: round(Math.min(area.y + area.height, hit.box.y + hit.box.height) - y),
                };
            })
            .filter((area) => area.width > 0.005 && area.height > 0.005);
        return clipped.length > 0 ? { ...hit, exclude: clipped } : hit;
    });
}

/** A hit as the REPL, the CLI and the editor list it: source seconds, where it plays, the box and how it moves. */
export interface PrivateHitOut {
    id: string;
    kind: PrivateHit["kind"];
    label: string;
    masked: string;
    from: number;
    to: number;
    /** Output seconds where it first shows in the edit now; null when that moment is cut. */
    plays: number | null;
    box: PrivateHit["box"];
    /** It moves (a scroll): its hidden part follows these keyframes. */
    moves: boolean;
    /** Areas its hidden part leaves visible (excludeFixed). */
    exclude?: FractionBox[];
    /** Source seconds where it moved and could not be followed: hideText hides the band it may cross there. */
    uncertain?: Array<{ from: number; to: number }>;
    /** Already hidden by an earlier hidePrivate or hideText. */
    hidden: boolean;
}

const seconds = (us: number): number => Math.round(us / 1000) / 1000;

function hitsOut(project: EditProject, hits: readonly PrivateHit[]): PrivateHitOut[] {
    const applied = new Set(project.privacy?.applied ?? []);
    return hits.map((hit) => {
        const plays = outputTimeOf(project, hit.fromUs);
        return {
            id: hit.id,
            kind: hit.kind,
            label: hit.label,
            masked: hit.masked,
            from: seconds(hit.fromUs),
            to: seconds(hit.toUs),
            plays: plays === undefined ? null : seconds(plays),
            box: hit.box,
            moves: hit.keys.length > 1,
            ...(hit.exclude ? { exclude: hit.exclude } : {}),
            ...(hit.uncertain
                ? {
                      uncertain: hit.uncertain.map((stretch) => ({
                          from: seconds(stretch.fromUs),
                          to: seconds(stretch.toUs),
                      })),
                  }
                : {}),
            hidden: applied.has(hit.id),
        };
    });
}

/** The private hits of an edit's movie (Vision OCR, local), the input of the `hidePrivate` op. */
export function privateHitsOf(
    project: EditProject,
    options: TrackOptions & { names?: readonly string[] } = {}
): Promise<PrivateHit[]> {
    return trackedHits(project, privateMatcher(options.names), options);
}

export async function privateData(
    project: EditProject,
    options: TrackOptions & { names?: readonly string[] } = {}
): Promise<PrivateHitOut[]> {
    return hitsOut(project, await privateHitsOf(project, options));
}

/**
 * What findText, hideText and verifyHidden look for: a text or a pattern, or several (R6 3, one scan), and how much of
 * its OCR line a match covers (R6 2).
 */
export type TextQuery = TextMatcherOptions;

/** Every place of a text (or a pattern) on the screen, the input of the `hideText` op. */
export async function textHitsOf(project: EditProject, options: TrackOptions & TextQuery): Promise<PrivateHit[]> {
    let read: readonly ScreenTextFrame[] = [];
    const hits = await trackedHits(project, textMatcher(options), {
        ...options,
        onRead: (frames) => {
            read = frames;
            options.onRead?.(frames);
        },
    });

    // R8 7: a pattern that never matched is said, not silently dropped (a \w that did not take Czech letters did).
    for (const query of unmatchedQueries(read, options)) {
        log.out.warn(
            `no screen text ${options.scan ? "of the range read" : "of the whole movie"} matches ${query}: each OCR line is matched on its own, without case; \\w and \\b take letters of any language, \\p{L} is any letter`
        );
    }

    return hits;
}

export async function findText(
    project: EditProject,
    options: TrackOptions & TextQuery & { from?: TimeValue; to?: TimeValue }
): Promise<PrivateHitOut[]> {
    // R7 6: from/to (source seconds) as hideText takes them; a place that shows at any moment between them counts.
    const fromUs = options.from === undefined ? 0 : timeToUs(options.from);
    const toUs = options.to === undefined ? Number.POSITIVE_INFINITY : timeToUs(options.to);
    const hits = await textHitsOf(project, { ...options, scan: options.scan ?? scanOf(options.from, options.to) });
    return hitsOut(
        project,
        hits.filter((hit) => hit.toUs > fromUs && hit.fromUs < toUs)
    );
}

/** A moment of the export where the text is still readable. */
export interface Leak {
    /** Seconds of the export file (an intro card included). */
    at: number;
    until: number;
    /** R6 5: the same moment in output seconds (what plays, without the intro card); null inside a card. */
    output: { at: number; until: number } | null;
    /** R6 5: where it starts and ends in the source movie (seconds), the time an op takes; null inside a card. */
    source: { at: number; until: number } | null;
    label: string;
    masked: string;
    /** Where it was read on the EXPORT frame: fractions of the export's picture (the canvas, a frame and zoom included). */
    box: FractionBox;
    /**
     * R7 3: the same text in the SOURCE picture (fractions of the source movie's picture, what `redact` takes), from the
     * source's own reads at that time; null when it cannot be placed there (inside a card, or not read in the source).
     */
    sourceBox: FractionBox | null;
    /** R8 4: its place in the SOURCE picture at each frame it was read (source seconds and fractions); fixOps follow it. */
    sourceKeys: Array<{ at: number; x: number; y: number; width: number; height: number }>;
}

/**
 * Whether a text is still readable in the edit's OUTPUT: the edit is exported (or `movie`, an export of it already
 * made, is read), its frames are read with Vision every `everySeconds` (0.25), and every run of frames where `text`,
 * `pattern`, `texts`, `patterns` or the private data (`private: true`, with `names`) can still be read is a leak, at
 * export, output and source seconds. ok is true without one. `onProgress` gets a line per tenth of the export and of
 * the frames read ("read 40 of 150 frames").
 */
export async function verifyHidden(
    value: string,
    options: Omit<TextQuery, "unit"> & {
        private?: boolean;
        names?: readonly string[];
        everySeconds?: number;
        movie?: string;
        /** R7 4: every frame this close to a cut, a transition, a zoom's or a hidden part's edge or a scene change (0.2). */
        aroundSeconds?: number;
        onProgress?: (line: string) => void;
    }
): Promise<{ ok: boolean; movie: string; frames: number; leaks: Leak[]; fixOps: EditOp[]; notes?: string[] }> {
    const asked = Boolean(options.text || options.pattern || options.texts?.length || options.patterns?.length);
    // R6 3: every text and pattern (and the private data, when asked or when nothing else is) in one read.
    const matchers = [
        ...(asked ? [textMatcher(options)] : []),
        ...(options.private || !asked ? [privateMatcher(options.names)] : []),
    ];
    const matcher: LineMatcher = (text) => matchers.flatMap((one) => one(text));
    const { project } = await openProject(value);
    const progress = options.onProgress ?? (() => undefined);
    let movie = options.movie;

    if (!movie) {
        const scratch = mkdtempSync(join(tmpdir(), "gt-verify-hidden-"));
        const answer = await exportAs(value, {
            out: join(scratch, "verify.mp4"),
            format: "mp4",
            onProgress: exportProgressPrinter((line) => progress(`verifyHidden: ${line}`)),
        });

        if (!answer.ok || !answer.path) {
            throw new Error(`the export to check failed: ${answer.error ?? "no file"}`);
        }

        movie = answer.path;
    }

    const info = await probeVideo({ input: movie });
    const durationUs = info.durationUs;
    let shown = -1;
    const even = await ocrVideo({
        video: movie,
        toUs: durationUs,
        fps: 1 / (options.everySeconds ?? 0.25),
        onFrame: (done, total) => {
            const tenth = Math.floor((done / Math.max(1, total)) * 10);

            if (tenth > shown) {
                shown = tenth;
                progress(`verifyHidden: read ${done} of ${total} frames`);
            }
        },
    });
    // R7 4: every frame around each cut, transition, zoom and hidden part's edge and scene change, where one frame is
    // enough to show a text (a blended frame at a join, the frame before a part starts, a slide at a screen change).
    const windows = boundaryWindows(project, {
        aroundUs: Math.round((options.aroundSeconds ?? 0.2) * 1_000_000),
        sceneUs: await sceneChangesOf(project),
    });
    // Every frame: the export runs at 60 fps at most, and a repeated frame is read once (ocrVideo compares them).
    const exportFps = 60;
    const dense: ScreenTextFrame[] = [];

    for (const [index, [fromUs, toUs]] of windows.entries()) {
        progress(`verifyHidden: every frame around edge ${index + 1} of ${windows.length}`);
        dense.push(...(await ocrVideo({ video: movie, fromUs, toUs: Math.min(durationUs, toUs), fps: exportFps })));
    }

    const frames = mergeFrames(even, dense);
    // R6 5: an export starts with the intro card; what plays after it is the output, and each output moment a source one.
    const endUs = cardsLeadUs(project) + outputDurationUs(project);
    // R7: a few characters of a value the source shows (a heading that slid out at the edge) are a leak of it too.
    const { frames: sourceFrames } = await screenTextOf(project);
    const values = sourceFrames.flatMap((frame) =>
        frame.lines.flatMap((line) => matcher(line.text).map((match) => match.value))
    );
    const leaks = textHits(frames, edgeFragments(matcher, values), { gapUs: 0 }).map((hit) => {
        const atUs = hit.keys[0]?.atUs ?? hit.fromUs;
        const from = exportToOutputUs(project, atUs);
        const to = exportToOutputUs(project, Math.min(hit.toUs, endUs));
        return {
            at: seconds(atUs),
            until: seconds(hit.toUs),
            output: from === undefined || to === undefined ? null : { at: seconds(from), until: seconds(to) },
            source:
                from === undefined || to === undefined
                    ? null
                    : {
                          at: seconds(sourceTimeOf(project, from)),
                          until: seconds(sourceTimeOf(project, Math.max(from, to - 1))),
                      },
            label: hit.label,
            masked: hit.masked,
            box: hit.box,
            keys: hit.keys,
        };
    });
    // R7 3: each leak's place in the source picture, from the source's own reads, and the redact ops that cover it.
    const sourceHits = leaks.some((leak) => leak.source) ? await trackedHits(project, matcher) : [];
    const placed: Leak[] = leaks.map(({ keys, ...leak }) => ({
        ...leak,
        // R8 4: its place in the source at every frame it was read, the track of its fix.
        sourceKeys: leak.source
            ? leakSourceKeys(project, { keys, label: leak.label, masked: leak.masked, sourceHits })
            : [],
        sourceBox: leak.source
            ? leakSourceBox(project, {
                  fromUs: Math.round(leak.source.at * 1_000_000),
                  toUs: Math.round(leak.source.until * 1_000_000),
                  label: leak.label,
                  masked: leak.masked,
                  canvasBox: leak.box,
                  sourceHits,
              })
            : null,
    }));
    // R8 4: a leak with no place in the source gets no fix op (never a box over the whole frame), but a note.
    const notes = placed
        .filter((leak) => leak.source && leak.sourceKeys.length === 0)
        .map(
            (leak) =>
                `the leak at ${leak.source?.at} to ${leak.source?.until} s (source) has no place in the source picture (the source never read it there): hide it by hand from its export box, or with still({ source: true, full: true }) at that time`
        );
    return {
        ok: placed.length === 0,
        movie,
        frames: frames.length,
        leaks: placed,
        fixOps: leakFixOps(placed),
        ...(notes.length > 0 ? { notes } : {}),
    };
}

/** Two reads of one movie merged in time order; a dense read wins over an even one within 5 ms of it. */
function mergeFrames(even: readonly ScreenTextFrame[], dense: readonly ScreenTextFrame[]): ScreenTextFrame[] {
    const kept = even.filter((frame) => !dense.some((other) => Math.abs(other.atUs - frame.atUs) < 5000));
    const all = [...kept, ...dense].sort((a, b) => a.atUs - b.atUs);
    // Each frame shows until the next one read.
    return all.map((frame, index) => ({ ...frame, untilUs: all[index + 1]?.atUs ?? frame.untilUs }));
}

/** R7 4: the source times where the screen changes at once (a new screen, a tab): over a third of the picture in a step. */
async function sceneChangesOf(project: EditProject): Promise<number[]> {
    try {
        const { steps, fps } = await changeStepsOf(project);
        return steps.flatMap((step, index) =>
            step.changed / Math.max(1, step.cells) > 1 / 3 ? [Math.round((index * 1_000_000) / fps)] : []
        );
    } catch (error) {
        logger.debug({ error }, "verifyHidden: no change steps, so no scene changes to read around");
        return [];
    }
}

const stepsSchema = z.array(
    z.object({
        changed: z.number(),
        cells: z.number(),
        box: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional(),
        mask: z.string().optional(),
        dy: z.number().optional(),
    })
);
const stepsCacheSchema = z.object({
    steps: stepsSchema,
    grid: z.object({ columns: z.number(), rows: z.number() }),
    fps: z.number(),
    height: z.number(),
});

/** The movie's change steps, cached once per movie content (analysis-cache.ts). */
export async function changeStepsOf(
    project: EditProject
): Promise<{ steps: ChangeStep[]; grid: { columns: number; rows: number }; fps: number; height: number }> {
    const video = project.source.video;

    if (!existsSync(video)) {
        throw new Error(`the movie ${video} is not there, so its picture cannot be compared`);
    }

    // v3: sampled on the editor time base (sampleFpsFilter); v2 caches took the nearest frame.
    return cachedAnalysis({
        ...analysisOf(video, "waits", `fps=${WAIT_SAMPLE_FPS},v3`, stepsCacheSchema),
        compute: () => measureChangeSteps({ video, width: project.source.width, height: project.source.height }),
    });
}

/** The moments the viewer must see at normal speed: clicks (±0.5 s), cursor moves, and speech (±0.2 s). */
function busyRanges(project: EditProject): Array<[number, number]> {
    const busy: Array<[number, number]> = [];
    const samples = readCursorTrack(project.source.cursor);
    const bucketMs = 250;
    const travel = new Map<number, number>();

    for (const [index, sample] of samples.entries()) {
        if (sample.click) {
            busy.push([Math.max(0, (sample.ms - 500) * 1000), (sample.ms + 500) * 1000]);
        }

        const previous = samples[index - 1];

        if (previous) {
            const bucket = Math.floor(sample.ms / bucketMs);
            travel.set(bucket, (travel.get(bucket) ?? 0) + Math.hypot(sample.x - previous.x, sample.y - previous.y));
        }
    }

    for (const [bucket, distance] of travel) {
        // A fiftieth of the picture in a quarter second: a real move, not a hand resting on the mouse.
        if (distance > 0.02) {
            busy.push([bucket * bucketMs * 1000, (bucket + 1) * bucketMs * 1000]);
        }
    }

    if (existsSync(transcriptCachePath(project.source.video))) {
        for (const segment of readTranscriptSegments(project)) {
            if (segment.text.trim()) {
                busy.push([Math.max(0, (segment.start - 0.2) * 1_000_000), (segment.end + 0.2) * 1_000_000]);
            }
        }
    }

    return busy;
}

/** The typing and waiting stretches of an edit's movie, inside its kept parts at normal speed. */
export async function waitsOf(
    project: EditProject,
    options: { minSeconds?: number; maxArea?: number } = {}
): Promise<WaitStretch[]> {
    const { steps, grid, fps } = await changeStepsOf(project);
    return waitStretches({
        steps,
        fps,
        grid,
        minUs: (options.minSeconds ?? 4) * 1_000_000,
        maxArea: options.maxArea ?? 0.06,
        busyUs: busyRanges(project),
        withinUs: project.clips.filter((clip) => clip.speed === 1).map((clip) => [clip.fromUs, clip.toUs]),
    });
}

/** A stretch as the REPL, the CLI and the editor list it. */
export interface WaitOut {
    id: string;
    kind: WaitStretch["kind"];
    from: number;
    to: number;
    seconds: number;
    speed: number;
    /** Seconds the speed-up takes off the movie. */
    saves: number;
    plays: number | null;
    region: WaitStretch["region"] | null;
}

export async function waits(
    project: EditProject,
    options: { minSeconds?: number; maxArea?: number } = {}
): Promise<WaitOut[]> {
    return (await waitsOf(project, options)).map((wait) => {
        const plays = outputTimeOf(project, wait.fromUs);
        const length = wait.toUs - wait.fromUs;
        return {
            id: wait.id,
            kind: wait.kind,
            from: seconds(wait.fromUs),
            to: seconds(wait.toUs),
            seconds: seconds(length),
            speed: wait.speed,
            saves: seconds(length - length / wait.speed),
            plays: plays === undefined ? null : seconds(plays),
            region: wait.region ?? null,
        };
    });
}

// fx B (round 4): the events of a movie, so effects are placed on what happens on screen.

/** An event as the REPL and the CLI list it: source seconds, and where it plays in the edit now. */
export interface MovieEventOut {
    kind: MovieEvent["kind"];
    index: number;
    at: number;
    to?: number;
    plays: number | null;
    shift?: number;
    x?: number;
    y?: number;
}

/** The events of an edit's movie: scene changes, scrolls, still stretches, clicks, and `taps` the caller passes. */
export async function eventsOf(project: EditProject, options: { taps?: readonly Tap[] } = {}): Promise<MovieEvent[]> {
    const { steps, fps, height } = await changeStepsOf(project);
    const events = movieEvents({
        steps,
        fps,
        pictureHeight: height,
        clicks: readCursorTrack(project.source.cursor).filter((sample) => sample.click),
        taps: options.taps,
    });
    // R7 8: each scene at the frame it starts on, not the 4-a-second sample after it.
    const scenes = events.filter((event) => event.kind === "scene");

    if (scenes.length === 0) {
        return events;
    }

    const video = project.source.video;
    const times = await cachedAnalysis({
        ...analysisOf(
            video,
            "scenes",
            `scenes,v2,${scenes.map((scene) => scene.fromUs).join(",")}`,
            z.array(z.number())
        ),
        compute: () =>
            refineSceneTimes({
                video,
                width: project.source.width,
                height: project.source.height,
                scenesUs: scenes.map((scene) => scene.fromUs),
                stepUs: 1_000_000 / fps,
            }),
    });
    const moved = new Map(scenes.map((scene, index) => [scene, times[index] ?? scene.fromUs]));
    return events
        .map((event) => ({ ...event, fromUs: moved.get(event) ?? event.fromUs }))
        .sort((a, b) => a.fromUs - b.fromUs);
}

export function eventsOut(project: EditProject, events: readonly MovieEvent[]): MovieEventOut[] {
    return events.map((event) => {
        const plays = outputTimeOf(project, event.fromUs);
        return {
            kind: event.kind,
            index: event.index,
            at: seconds(event.fromUs),
            ...(event.toUs === undefined ? {} : { to: seconds(event.toUs) }),
            plays: plays === undefined ? null : seconds(plays),
            ...(event.shift === undefined ? {} : { shift: event.shift }),
            ...(event.x === undefined ? {} : { x: event.x, y: event.y }),
        };
    });
}

/**
 * A source time on screen: `at` (seconds) moved to the nearest event of `kinds`, or an anchor's time
 * (`{ event: "scene", index: 3, lead: -0.2 }`). Answers the seconds and the event it used.
 */
export async function snapOf(
    project: EditProject,
    options: { at?: number; anchor?: EventAnchor; kinds?: MovieEventKind[]; taps?: readonly Tap[] }
): Promise<{ at: number; event: MovieEventOut; edge?: "start" | "end" }> {
    const events = await eventsOf(project, { taps: options.taps });

    if (options.anchor) {
        const anchor = options.anchor;
        const atUs = anchorTimeUs(events, anchor);
        const ofKind = events.filter((item) => item.kind === anchor.event);
        const event = ofKind.at(anchor.index > 0 ? anchor.index - 1 : anchor.index);

        if (!event) {
            throw new RangeError(`there is no ${anchor.event} event ${anchor.index}`);
        }

        return { at: seconds(atUs), event: eventsOut(project, [event])[0] };
    }

    if (options.at === undefined) {
        throw new Error("snap needs at (seconds) or an event anchor ({ event, index, lead? })");
    }

    const nearest = nearestEvent(events, Math.round(options.at * 1_000_000), options.kinds);

    if (!nearest) {
        throw new RangeError(
            `the movie has no ${options.kinds ? `${options.kinds.join(" or ")} ` : ""}event to snap to`
        );
    }

    return { at: seconds(nearest.atUs), event: eventsOut(project, [nearest.event])[0], edge: nearest.edge };
}
