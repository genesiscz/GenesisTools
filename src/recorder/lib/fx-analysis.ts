import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { recognizeTextBoxes } from "@genesiscz/utils/macos/ocr-boxes";
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
import {
    type FractionBox,
    type LineMatcher,
    type PrivateHit,
    privateMatcher,
    type ScreenTextFrame,
    textHits,
    textMatcher,
} from "@genesiscz/utils/recording-editor/private-data";
import {
    type EditProject,
    outputTimeOf,
    readCursorTrack,
    transcriptCachePath,
} from "@genesiscz/utils/recording-editor/project";
import {
    type ChangeStep,
    fixedAreas,
    measureChangeSteps,
    WAIT_SAMPLE_FPS,
    type WaitStretch,
    waitStretches,
} from "@genesiscz/utils/recording-editor/waits";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";
import { exportAs, readTranscriptSegments } from "./edit";
import { boxInProxy, proxyCanvas, readDisplayPlan } from "./proxy";
import { displaySizes, frameTexts, visibleSpans } from "./screen-search";

const { log } = logger.scoped("recorder-fx-analysis");

/**
 * The analysis behind three editor effects: the screen text of a movie (for private data), and the picture's change
 * steps (for typing and waiting speed-ups). Both are slow, so each is cached beside the edit and reused while the
 * movie stays the same file. The screen text is read with Vision on this Mac (darwinkit); nothing is sent anywhere.
 */

/** Where an analysis of `video` is cached: `<folder>/<name>.json` for a recording folder, `<movie>.<name>.json` else. */
function cachePath(video: string, name: string): string {
    const folder = dirname(video);
    return existsSync(join(folder, "recording.json"))
        ? join(folder, `${name}.json`)
        : join(folder, `${basename(video, extname(video))}.${name}.json`);
}

/** What makes a cache stale: another movie file, or another way of reading it. */
function movieKey(video: string, extra: string): string {
    const stat = statSync(video);
    return `${stat.size}:${Math.round(stat.mtimeMs)}:${extra}`;
}

function readCache<T>(path: string, key: string, schema: z.ZodType<T>): T | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed = z
            .object({ key: z.string(), data: schema })
            .safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
        return parsed.success && parsed.data.key === key ? parsed.data.data : undefined;
    } catch (error) {
        log.debug({ error, path }, "an analysis cache does not read; it is made again");
        return undefined;
    }
}

function writeCache(path: string, key: string, data: unknown): void {
    try {
        atomicWriteFileSync(path, SafeJSON.stringify({ key, data }));
    } catch (error) {
        log.warn({ error, path }, "an analysis cache could not be written; the next call reads the movie again");
    }
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

        for (const file of files) {
            const path = join(folder, file);
            const digest = createHash("sha1").update(readFileSync(path)).digest("hex");

            if (digest !== previousDigest) {
                const read = await recognizeTextBoxes(path, { fastFallback: false });
                previousLines = read.lines.map((line) => ({
                    text: line.text,
                    x: line.x / read.width,
                    y: line.y / read.height,
                    width: line.width / read.width,
                    height: line.height / read.height,
                }));
                previousDigest = digest;
            }

            const atUs = Math.round(fromUs + Number(file.replace(".png", "")) * stepUs);
            frames.push({ atUs, untilUs: Math.min(options.toUs, Math.round(atUs + stepUs)), lines: previousLines });
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

/**
 * The movie's screen text as frames of OCR lines over its picture. A frames recording's own OCR, else a Vision read
 * of sampled movie frames, cached in `screen-text.json` beside the edit.
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

    const path = cachePath(video, "screen-text");
    // editor-time: sampled on the editor time base (sampleFpsFilter); older caches took the nearest frame.
    const key = movieKey(video, `every=${screenTextEverySeconds(project.source.durationUs)},editor-time`);
    const cached = readCache(path, key, screenFramesSchema);

    if (cached) {
        return { frames: cached, source: "movie", cached: true };
    }

    const started = Date.now();
    const frames = await movieScreenText(project);
    log.debug({ video, frames: frames.length, ms: Date.now() - started }, "movie screen text read with Vision");
    writeCache(path, key, frames);
    return { frames, source: "movie", cached: false };
}

/** Frames a second around a hit's edges and while it moves: a scrolling line is placed every 0.2 s. */
const DENSE_FPS = 5;

const denseSchema = z.record(z.string(), screenFramesSchema.element.shape.lines);

/**
 * Vision OCR of the movie at `DENSE_FPS` inside `windows` (source microseconds), cached by frame time in
 * `screen-text-dense.json`, so a second search reads only the frames it has not read yet.
 */
async function denseScreenText(
    project: EditProject,
    windows: ReadonlyArray<[number, number]>
): Promise<ScreenTextFrame[]> {
    const video = project.source.video;
    const path = cachePath(video, "screen-text-dense");
    const key = movieKey(video, `dense=${DENSE_FPS}`);
    const cache: Record<string, ScreenTextFrame["lines"]> = { ...(readCache(path, key, denseSchema) ?? {}) };
    const stepUs = 1_000_000 / DENSE_FPS;
    const frames: ScreenTextFrame[] = [];
    let read = false;

    for (const [fromUs, toUs] of windows) {
        const start = Math.floor(fromUs / stepUs) * stepUs;
        const times: number[] = [];

        for (let atUs = start; atUs < toUs; atUs += stepUs) {
            times.push(Math.round(atUs));
        }

        if (times.some((atUs) => !cache[String(atUs)])) {
            for (const frame of await ocrVideo({ video, fromUs: start, toUs, fps: DENSE_FPS })) {
                const atUs = Math.round(Math.round((frame.atUs - start) / stepUs) * stepUs + start);
                cache[String(atUs)] = frame.lines;
            }

            read = true;
        }

        for (const atUs of times) {
            frames.push({
                atUs,
                untilUs: Math.min(project.source.durationUs, atUs + stepUs),
                lines: cache[String(atUs)] ?? [],
            });
        }
    }

    if (read) {
        writeCache(path, key, cache);
    }

    return frames;
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
    const path = cachePath(video, "motion");
    const key = movieKey(video, `motion=${MOTION_FPS},v1`);
    const cache = { ...(readCache(path, key, motionCacheSchema) ?? {}) };
    const windows: MotionWindow[] = [];
    let measured = false;

    for (const [fromUs, toUs] of stretches) {
        const name = `${Math.round(fromUs)}-${Math.round(toUs)}`;
        const known = cache[name];

        if (known) {
            windows.push(motionWindowFromJson(known));
            continue;
        }

        const window = await measureMotion({
            video,
            sourceWidth: project.source.width,
            sourceHeight: project.source.height,
            fromUs,
            toUs,
        });
        cache[name] = motionWindowSchema.parse(motionWindowToJson(window));
        windows.push(window);
        measured = true;
    }

    if (measured) {
        writeCache(path, key, cache);
    }

    log.debug({ video, stretches: stretches.length, measured }, "the content's motion is ready");
    return windows;
}

export interface TrackOptions {
    exclude?: readonly FractionBox[];
    /** Leave visible what stays still while the content under it moves. */
    excludeFixed?: boolean;
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
    const { frames: coarse, source } = await screenTextOf(project);
    const exclude = options.exclude ?? [];

    if (source === "frames") {
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

    const merged = mergeWindows(windows);
    const dense = await denseScreenText(project, merged);
    const outside = coarse.filter((frame) => !merged.some(([from, to]) => frame.atUs >= from && frame.atUs < to));
    const seen = [...outside, ...dense].filter((frame) => matches(frame)).map((frame) => frame.atUs);
    const motion = new MotionField(await motionWindows(project, movingStretches({ steps, fps }, seen)), {
        steps,
        fps,
        grid,
    });
    const hits = textHits([...outside, ...dense], matcher, { exclude, motion });

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

/** Every place of a text (or a pattern) on the screen, the input of the `hideText` op. */
export function textHitsOf(
    project: EditProject,
    options: TrackOptions & { text?: string; pattern?: string }
): Promise<PrivateHit[]> {
    return trackedHits(project, textMatcher(options), options);
}

export async function findText(
    project: EditProject,
    options: TrackOptions & { text?: string; pattern?: string }
): Promise<PrivateHitOut[]> {
    return hitsOut(project, await textHitsOf(project, options));
}

/** A moment of the OUTPUT where the text is still readable. */
export interface Leak {
    /** Output seconds. */
    at: number;
    until: number;
    label: string;
    masked: string;
    box: FractionBox;
}

/**
 * Whether a text is still readable in the edit's OUTPUT: the edit is exported (or `movie`, an export already made, is
 * read), its frames are read with Vision every `everySeconds` (0.25), and every run of frames where `text`, `pattern`
 * or the private data (`private: true`, with `names`) can still be read is a leak. ok is true without one.
 */
export async function verifyHidden(
    value: string,
    options: {
        text?: string;
        pattern?: string;
        private?: boolean;
        names?: readonly string[];
        everySeconds?: number;
        movie?: string;
    }
): Promise<{ ok: boolean; movie: string; frames: number; leaks: Leak[] }> {
    const matcher =
        options.private || (!options.text && !options.pattern) ? privateMatcher(options.names) : textMatcher(options);
    let movie = options.movie;

    if (!movie) {
        const scratch = mkdtempSync(join(tmpdir(), "gt-verify-hidden-"));
        const answer = await exportAs(value, { out: join(scratch, "verify.mp4"), format: "mp4" });

        if (!answer.ok || !answer.path) {
            throw new Error(`the export to check failed: ${answer.error ?? "no file"}`);
        }

        movie = answer.path;
    }

    const { durationUs } = await probeVideo({ input: movie });
    const frames = await ocrVideo({ video: movie, toUs: durationUs, fps: 1 / (options.everySeconds ?? 0.25) });
    const leaks = textHits(frames, matcher, { gapUs: 0 }).map((hit) => ({
        at: seconds(hit.keys[0]?.atUs ?? hit.fromUs),
        until: seconds(hit.toUs),
        label: hit.label,
        masked: hit.masked,
        box: hit.box,
    }));
    return { ok: leaks.length === 0, movie, frames: frames.length, leaks };
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

/** The movie's change steps, cached in `waits.json` beside the edit. */
export async function changeStepsOf(
    project: EditProject
): Promise<{ steps: ChangeStep[]; grid: { columns: number; rows: number }; fps: number; height: number }> {
    const video = project.source.video;

    if (!existsSync(video)) {
        throw new Error(`the movie ${video} is not there, so its picture cannot be compared`);
    }

    const path = cachePath(video, "waits");
    // v3: sampled on the editor time base (sampleFpsFilter); v2 caches took the nearest frame.
    const key = movieKey(video, `fps=${WAIT_SAMPLE_FPS},v3`);
    const cached = readCache(path, key, stepsCacheSchema);

    if (cached) {
        return cached;
    }

    const measured = await measureChangeSteps({
        video,
        width: project.source.width,
        height: project.source.height,
    });
    writeCache(path, key, measured);
    return measured;
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
    return movieEvents({
        steps,
        fps,
        pictureHeight: height,
        clicks: readCursorTrack(project.source.cursor).filter((sample) => sample.click),
        taps: options.taps,
    });
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
