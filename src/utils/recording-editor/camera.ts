import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { RecordingSpan } from "@genesiscz/utils/screen-recorder/library";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";
import { sampleFpsFilter } from "./ffmpeg";
import { recordingItemId } from "./item-ids";

const { log } = logger.scoped("recording-editor-camera");

/** The camera's sidecar beside a recording, written by the recorder face when the recording ends. */
export const CAMERA_SIDECAR = "camera.json";

export const CAMERA_SHAPES = ["circle", "rounded", "square"] as const;
export type CameraShape = (typeof CAMERA_SHAPES)[number];

/** A corner keeps the bubble `margin` from two edges; `custom` places its centre at (x, y). */
export const CAMERA_CORNERS = ["bottomRight", "bottomLeft", "topRight", "topLeft", "custom"] as const;
export type CameraCorner = (typeof CAMERA_CORNERS)[number];

/**
 * A stretch of SOURCE time (it moves with a cut, like a zoom) in which the bubble is not drawn: an item of kind
 * `cameraHide` on the editor's effect lanes (lanes.ts), with its own id and the lane it sits on.
 */
export const cameraHiddenSchema = z.object({
    id: z.string().min(1),
    startUs: z.number().int().nonnegative(),
    endUs: z.number().int().positive(),
    /** The effect lane it sits on (lanes.ts); absent is the first lane that holds camera parts. */
    lane: z.string().optional(),
});

/** A new hidden part's id ("k" for camera, like "z" for a zoom). */
export function cameraHiddenId(): string {
    return recordingItemId("k");
}

/**
 * Hidden parts saved before they were lane items had no id: each gets one from its start, the same on every read, so
 * a reader and a writer of an old file agree until the next save writes it.
 */
function withHiddenIds(raw: unknown): unknown {
    if (!Array.isArray(raw)) {
        return raw;
    }

    return raw.map((item) => {
        if (item === null || typeof item !== "object" || Reflect.has(item, "id")) {
            return item;
        }

        const start = Reflect.get(item, "startUs");
        return { ...item, id: `k${typeof start === "number" ? start.toString(36) : "0"}` };
    });
}

/**
 * The camera recorded beside the screen, drawn over the picture as a bubble. Hidden ranges are a plain list until the
 * editor's lanes model takes them as lane items.
 */
export const cameraBubbleSchema = z.object({
    /** The camera's movie; a bare name is beside the source movie. */
    file: z.string().min(1),
    /** The camera's time of a source moment is `source - offsetMs`: positive when the camera started later. */
    offsetMs: z.number().int().min(-600_000).max(600_000).default(0),
    show: z.boolean().default(true),
    corner: z.enum(CAMERA_CORNERS).default("bottomRight"),
    /** The centre when `corner` is custom, as fractions of the canvas. */
    x: z.number().min(0).max(1).default(0.88),
    y: z.number().min(0).max(1).default(0.82),
    /** The bubble's side as a fraction of the canvas's short side. */
    size: z.number().min(0.08).max(0.6).default(0.24),
    shape: z.enum(CAMERA_SHAPES).default("circle"),
    /** A mirror image, as the person saw themselves while recording. */
    mirror: z.boolean().default(true),
    /** The gap to the canvas edges for a corner, as a fraction of the short side. */
    margin: z.number().min(0).max(0.2).default(0.035),
    hidden: z.preprocess(withHiddenIds, z.array(cameraHiddenSchema)).default([]),
});
export type CameraBubble = z.infer<typeof cameraBubbleSchema>;

/**
 * What a camera movie's time counts. `wall`: every moment since its first frame, pauses and the gaps between screen
 * segments included (the face since 2026-11-09). `screen`: the screen movie's own time, once the recording cut it to
 * the screen's spans (`alignCameraMovie`). A sidecar without it was written by a face that left out the paused time it
 * saw, late by its watch of the live state.
 */
export const CAMERA_CLOCKS = ["wall", "screen"] as const;

/** What the recorder face writes into `camera.json`: the movie, when it began, and where the bubble was dragged. */
export const cameraSidecarSchema = z.object({
    version: z.literal(1),
    file: z.string().min(1),
    /** The wall time (ISO) of the camera movie's time 0: its first frame, or the screen's first frame once cut. */
    startedAt: z.string(),
    /**
     * The wall time (ISO) of the screen movie's time 0, which the bubble's offset counts from: the screen's first frame
     * once the recording lined the camera up (`alignCameraMovie`); before that, when the face saw the recording start,
     * which is up to two seconds before the screen's first frame.
     */
    screenStartedAt: z.string().optional(),
    clock: z.enum(CAMERA_CLOCKS).optional(),
    device: z.string().optional(),
    placement: z
        .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            size: z.number().min(0.08).max(0.6),
            shape: z.enum(CAMERA_SHAPES),
        })
        .partial()
        .optional(),
});
export type CameraSidecar = z.infer<typeof cameraSidecarSchema>;

/** The `camera.json` beside a movie, or undefined when there is none or it does not parse (logged). */
export function readCameraSidecar(video: string): CameraSidecar | undefined {
    return readSidecarFile(join(dirname(video), CAMERA_SIDECAR));
}

function readSidecarFile(path: string): CameraSidecar | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    const parsed = cameraSidecarSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));

    if (!parsed.success) {
        log.warn({ path, issues: parsed.error.issues.length }, "camera.json does not parse; no camera bubble");
        return undefined;
    }

    return parsed.data;
}

/** The bubble a new edit starts with: the sidecar's movie at the place it was dragged to while recording. */
export function bubbleFromSidecar(sidecar: CameraSidecar): CameraBubble {
    const started = Date.parse(sidecar.startedAt);
    const screen = sidecar.screenStartedAt ? Date.parse(sidecar.screenStartedAt) : Number.NaN;
    const offsetMs = Number.isFinite(started) && Number.isFinite(screen) ? Math.round(started - screen) : 0;
    const placement = sidecar.placement ?? {};
    return cameraBubbleSchema.parse({
        file: sidecar.file,
        offsetMs: Math.max(-600_000, Math.min(600_000, offsetMs)),
        ...(placement.x === undefined || placement.y === undefined
            ? {}
            : { corner: "custom", x: placement.x, y: placement.y }),
        ...(placement.size === undefined ? {} : { size: placement.size }),
        ...(placement.shape === undefined ? {} : { shape: placement.shape }),
    });
}

/** A stretch of a camera movie in its own time: milliseconds from its first frame. */
export interface CameraRange {
    startMs: number;
    endMs: number;
}

/** The parts of a wall-clock camera movie that line up with a screen movie, in the screen's order. */
export interface CameraTrimPlan {
    /** Screen time before the camera's first frame: the cut movie holds that first frame this long. */
    padHeadMs: number;
    ranges: CameraRange[];
}

/**
 * Which parts of a camera movie that runs on the wall clock (its first frame at `cameraStartedAt`, epoch ms) show what
 * each screen span shows. Cut out and joined, they give a camera movie on the screen movie's own time, so the gaps the
 * screen leaves out (a pause, a rollover's re-arm, a retune, a switch) are left out of the camera too.
 */
export function cameraTrimPlan({
    cameraStartedAt,
    spans,
}: {
    cameraStartedAt: number;
    spans: readonly RecordingSpan[];
}): CameraTrimPlan {
    let padHeadMs = 0;
    const ranges: CameraRange[] = [];

    for (const span of spans) {
        const startMs = span.firstFrameEpochMs - cameraStartedAt;
        const endMs = startMs + span.lengthMs;

        // Spans come in wall order, so only the first ones can start before the camera did.
        if (endMs <= 0) {
            padHeadMs += span.lengthMs;
            continue;
        }

        if (startMs < 0) {
            padHeadMs -= startMs;
        }

        ranges.push({ startMs: Math.max(0, startMs), endMs });
    }

    return { padHeadMs, ranges };
}

/** The camera movie's frame rate (the face records at 30 fps, CameraBubble.swift `startCamera`). */
const CAMERA_FPS = 30;

/**
 * ffmpeg arguments that cut a camera movie to a trim plan in one pass: each kept frame keeps its exact offset inside
 * its range (a concat would start each range at its first frame, up to a frame late per span), and the constant-rate
 * pass holds the first frame through the head pad. The trim at the end stops the rate pass at the last range: without
 * it, ffmpeg holds the last frame until the input's own end.
 */
export function cameraAlignArgv({
    input,
    output,
    plan,
}: {
    input: string;
    output: string;
    plan: CameraTrimPlan;
}): string[] {
    const seconds = (ms: number) => (ms / 1000).toFixed(6);
    const select = plan.ranges
        .map((range) => `gte(t,${seconds(range.startMs)})*lt(t,${seconds(range.endMs)})`)
        .join("+");
    let outputMs = plan.padHeadMs;
    const shifts = plan.ranges.map((range) => {
        const shift = `T-${seconds(range.startMs)}+${seconds(outputMs)}`;
        outputMs += range.endMs - range.startMs;
        return { range, shift };
    });
    const last = shifts.at(-1)?.shift ?? "T";
    const setpts = shifts
        .slice(0, -1)
        .reduceRight((rest, { range, shift }) => `if(lt(T,${seconds(range.endMs)}),${shift},${rest})`, last);
    const filter = `select='${select}',setpts='(${setpts})/TB',${sampleFpsFilter(CAMERA_FPS)},trim=end=${seconds(outputMs)}`;
    return [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-i",
        input,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        filter,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-f",
        "mov",
        output,
    ];
}

/** What `alignCameraMovie` did: nothing, the offset only, or a camera movie cut to the screen's spans. */
export interface CameraAlignment {
    result: "skipped" | "offset" | "trimmed";
    /** Why the movie could not be cut; the offset still counts from the screen's first frame. */
    warning?: string;
}

/** Writes `camera.json` whole: a `.partial` file renamed over it, as the face writes it. */
async function writeSidecarFile(path: string, sidecar: CameraSidecar): Promise<void> {
    const partial = `${path}.partial`;
    await writeFile(partial, `${SafeJSON.stringify(sidecar, null, 2)}\n`);
    await rename(partial, path);
}

/**
 * Lines a recording's camera movie up with its screen movie, once both are finished. The screen movie leaves out every
 * gap between its segments (`spans`, from the recording session); a camera movie on the wall clock (`clock: "wall"`)
 * kept them, so it is cut to the spans and its `camera.json` then counts from the screen's first frame (offset 0,
 * `clock: "screen"`). One span is cut too: the camera kept filming through a pause before the stop, and through a
 * segment a restart discarded, and that footage must not stay in the folder's camera movie. A face that left out its
 * own pauses, or a cut that fails, keeps the movie and only moves `screenStartedAt` to the screen's first frame, which
 * removes the constant error.
 */
export async function alignCameraMovie({
    folder,
    spans,
    runCommand,
}: {
    folder: string;
    spans: readonly RecordingSpan[];
    /** Runs the cut; default ffmpeg through `runVideoCommand`. */
    runCommand?: (command: string[]) => Promise<unknown>;
}): Promise<CameraAlignment> {
    const path = join(folder, CAMERA_SIDECAR);
    const sidecar = readSidecarFile(path);
    const cameraStartedAt = sidecar ? Date.parse(sidecar.startedAt) : Number.NaN;
    const first = spans[0];

    if (!sidecar || !first || !Number.isFinite(cameraStartedAt) || sidecar.clock === "screen") {
        log.debug(
            { folder, sidecar: Boolean(sidecar), spans: spans.length, clock: sidecar?.clock },
            "the camera movie needs no alignment"
        );
        return { result: "skipped" };
    }

    const screenStartedAt = new Date(first.firstFrameEpochMs).toISOString();
    const offsetOnly = async (warning?: string): Promise<CameraAlignment> => {
        await writeSidecarFile(path, { ...sidecar, screenStartedAt });
        log.info(
            { folder, spans: spans.length, clock: sidecar.clock, was: sidecar.screenStartedAt, screenStartedAt },
            "the camera's offset now counts from the screen's first frame"
        );
        return warning ? { result: "offset", warning } : { result: "offset" };
    };

    if (sidecar.clock !== "wall") {
        return offsetOnly();
    }

    const plan = cameraTrimPlan({ cameraStartedAt, spans });
    const input = isAbsolute(sidecar.file) ? sidecar.file : join(folder, sidecar.file);
    const output = join(dirname(input), `.camera-aligned-${randomUUID()}.mov`);
    const lastMs = plan.ranges.at(-1)?.endMs ?? 0;
    // The pass decodes the whole camera movie: allow it real time on a long one, never less than two minutes.
    const run =
        runCommand ??
        ((command: string[]) => runVideoCommand({ command, timeoutMs: Math.max(120_000, Math.round(lastMs)) }));

    try {
        await run(cameraAlignArgv({ input, output, plan }));
        await rename(output, input);
    } catch (error) {
        await unlink(output).catch((cleanupError: unknown) => {
            log.debug({ error: cleanupError, output }, "no cut camera movie to clean up");
        });
        log.warn({ error, folder, spans: spans.length }, "the camera movie could not be cut to the screen's spans");
        const reason = error instanceof Error ? error.message : String(error);
        return offsetOnly(
            `The camera movie could not be lined up with the screen's ${spans.length} pieces, so the bubble drifts after each pause: ${reason.slice(0, 300)}`
        );
    }

    await writeSidecarFile(path, { ...sidecar, startedAt: screenStartedAt, screenStartedAt, clock: "screen" });
    log.info(
        { folder, spans: spans.length, padHeadMs: plan.padHeadMs, ranges: plan.ranges },
        "the camera movie is cut to the screen's spans"
    );
    return { result: "trimmed" };
}

/** The camera movie's path for a bubble of the edit whose source movie is `video`. */
export function cameraMoviePath(bubble: Pick<CameraBubble, "file">, video: string): string {
    return isAbsolute(bubble.file) ? bubble.file : join(dirname(video), bubble.file);
}

/** The bubble's centre and side in canvas fractions of the short side, for a canvas of `width` × `height`. */
export function bubbleRect(
    bubble: CameraBubble,
    canvas: { width: number; height: number }
): { x: number; y: number; side: number } {
    const short = Math.min(canvas.width, canvas.height);
    const side = bubble.size * short;
    const margin = bubble.margin * short;
    const half = side / 2;
    const clampX = (value: number) => Math.min(canvas.width - half, Math.max(half, value));
    const clampY = (value: number) => Math.min(canvas.height - half, Math.max(half, value));
    const left = margin + half;
    const right = canvas.width - margin - half;
    const top = margin + half;
    const bottom = canvas.height - margin - half;

    switch (bubble.corner) {
        case "bottomRight":
            return { x: right, y: bottom, side };
        case "bottomLeft":
            return { x: left, y: bottom, side };
        case "topRight":
            return { x: right, y: top, side };
        case "topLeft":
            return { x: left, y: top, side };
        case "custom":
            return { x: clampX(bubble.x * canvas.width), y: clampY(bubble.y * canvas.height), side };
    }
}

/** Whether the bubble shows at a source moment: on, and outside every hidden range. */
export function bubbleShowsAt(bubble: CameraBubble, sourceUs: number): boolean {
    return bubble.show && !bubble.hidden.some((range) => sourceUs >= range.startUs && sourceUs < range.endUs);
}

/** Hides the bubble from `fromUs` to `toUs` as a part of its own, in start order. */
export function hideCamera(bubble: CameraBubble, fromUs: number, toUs: number, id = cameraHiddenId()): CameraBubble {
    if (toUs <= fromUs) {
        throw new Error(`a camera hide needs its end after its start (got ${fromUs / 1e6}–${toUs / 1e6} s)`);
    }

    // The editor window's rule: a part is never merged into one it overlaps, so it keeps its id (selectable, movable).
    const hidden = [...bubble.hidden, { id, startUs: fromUs, endUs: toUs }].sort((a, b) => a.startUs - b.startUs);
    return { ...bubble, hidden };
}

/** Shows the bubble again from `fromUs` to `toUs`: the hidden ranges lose that part (one may split in two). */
export function showCamera(bubble: CameraBubble, fromUs: number, toUs: number): CameraBubble {
    const hidden = bubble.hidden.flatMap((range) => {
        if (range.endUs <= fromUs || range.startUs >= toUs) {
            return [range];
        }

        // The part before keeps the id; a part after a split in the middle is a new item on the same lane.
        const before = range.startUs < fromUs ? [{ ...range, endUs: fromUs }] : [];
        const after =
            range.endUs > toUs ? [{ ...range, id: before.length ? cameraHiddenId() : range.id, startUs: toUs }] : [];
        return [...before, ...after];
    });
    return { ...bubble, hidden };
}
