import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { recognizeTextBoxes } from "@genesiscz/utils/macos/ocr-boxes";
import { type PrivateHit, privateHits, type ScreenTextFrame } from "@genesiscz/utils/recording-editor/private-data";
import {
    type EditProject,
    outputTimeOf,
    readCursorTrack,
    transcriptCachePath,
} from "@genesiscz/utils/recording-editor/project";
import {
    type ChangeStep,
    measureChangeSteps,
    WAIT_SAMPLE_FPS,
    type WaitStretch,
    waitStretches,
} from "@genesiscz/utils/recording-editor/waits";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";
import { readTranscriptSegments } from "./edit";
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
async function movieScreenText(
    project: EditProject,
    onProgress?: (done: number, total: number) => void
): Promise<ScreenTextFrame[]> {
    const video = project.source.video;
    const everySec = screenTextEverySeconds(project.source.durationUs);
    const folder = mkdtempSync(join(tmpdir(), "gt-screen-text-"));

    try {
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                video,
                "-map",
                "0:v:0",
                "-vf",
                `fps=1/${everySec}`,
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

            const atUs = Number(file.replace(".png", "")) * everySec * 1_000_000;
            frames.push({
                atUs,
                untilUs: Math.min(project.source.durationUs, atUs + everySec * 1_000_000),
                lines: previousLines,
            });
            onProgress?.(index + 1, files.length);
        }

        return frames;
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
}

/**
 * The movie's screen text as frames of OCR lines over its picture. A frames recording's own OCR, else a Vision read
 * of sampled movie frames, cached in `screen-text.json` beside the edit.
 */
export async function screenTextOf(
    project: EditProject,
    options: { onProgress?: (done: number, total: number) => void } = {}
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
    const key = movieKey(video, `every=${screenTextEverySeconds(project.source.durationUs)}`);
    const cached = readCache(path, key, screenFramesSchema);

    if (cached) {
        return { frames: cached, source: "movie", cached: true };
    }

    const started = Date.now();
    const frames = await movieScreenText(project, options.onProgress);
    log.debug({ video, frames: frames.length, ms: Date.now() - started }, "movie screen text read with Vision");
    writeCache(path, key, frames);
    return { frames, source: "movie", cached: false };
}

/** A private hit as the REPL, the CLI and the editor list it: source seconds, where it plays, the box. */
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
    /** Already hidden by an earlier hidePrivate. */
    hidden: boolean;
}

const seconds = (us: number): number => Math.round(us / 1000) / 1000;

/** The private hits of an edit's movie (Vision OCR, local), the input of the `hidePrivate` op. */
export async function privateHitsOf(project: EditProject): Promise<PrivateHit[]> {
    const { frames } = await screenTextOf(project);
    return privateHits(frames);
}

export async function privateData(project: EditProject): Promise<PrivateHitOut[]> {
    const applied = new Set(project.privacy?.applied ?? []);
    return (await privateHitsOf(project)).map((hit) => {
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
            hidden: applied.has(hit.id),
        };
    });
}

const stepsSchema = z.array(
    z.object({
        changed: z.number(),
        cells: z.number(),
        box: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).optional(),
    })
);
const stepsCacheSchema = z.object({
    steps: stepsSchema,
    grid: z.object({ columns: z.number(), rows: z.number() }),
    fps: z.number(),
});

/** The movie's change steps, cached in `waits.json` beside the edit. */
async function changeStepsOf(
    project: EditProject
): Promise<{ steps: ChangeStep[]; grid: { columns: number; rows: number }; fps: number }> {
    const video = project.source.video;

    if (!existsSync(video)) {
        throw new Error(`the movie ${video} is not there, so its picture cannot be compared`);
    }

    const path = cachePath(video, "waits");
    const key = movieKey(video, `fps=${WAIT_SAMPLE_FPS}`);
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
