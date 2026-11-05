import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { composeImageGrid, type ImageGridResult } from "@genesiscz/utils/image/grid";
import { decodeImageRgba } from "@genesiscz/utils/image/raster";
import {
    type Job,
    type JobRegistry,
    type JobStep,
    type ProgressEvent,
    runJob,
    type StepContext,
    type StepReport,
} from "@genesiscz/utils/jobs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { RECORDING_MANIFEST } from "@genesiscz/utils/screen-recorder/library";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { FrameDifferenceGuard } from "@genesiscz/utils/video/difference-guard";
import { probeVideo, readVideoFrameTimes } from "@genesiscz/utils/video/probe";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { locateVideoSamples } from "@genesiscz/utils/video/sampling";
import type { VideoInfo } from "@genesiscz/utils/video/types";
import { concatList, exportFramesArgv, exportVideoArgv, speedArgv, trimArgv } from "./ffmpeg";
import { type EditPlan, type EditPlanInput, type EditStep, parseEditPlan, stepWindow } from "./plan";
import {
    type LoadedSource,
    type LocatedSource,
    loadSource,
    locateSource,
    readFrameFolder,
    type SourceFrame,
} from "./source";

const { log } = logger.scoped("recording-editor");

/** Full-resolution frames one extraction may decode at once. */
const FRAME_BUDGET_BYTES = 1024 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 600_000;

export interface EditFrame {
    id: string;
    requestedUs?: number;
    actualUs: number;
    /** The frame's index in the video, for a video source. */
    sourceIndex?: number;
    path: string;
    displayId?: number;
    kept: boolean;
    differencePct: number | null;
    comparedToId: string | null;
}

export interface EditSheet extends ImageGridResult {
    path: string;
    frameIds: string[];
    firstUs: number;
    lastUs: number;
}

export interface EditExport {
    path: string;
    format: string;
}

/** The state that flows through the steps, as JSON: it is what a receipt stores. */
export interface EditState {
    source?: LoadedSource;
    /** The video the next step reads: the source, or a trim or speed result. */
    video?: { path: string; info: VideoInfo };
    /** The frames the next step reads, for a frames source. */
    stills?: SourceFrame[];
    window: { fromUs?: number; toUs?: number };
    frames?: EditFrame[];
    sheets: EditSheet[];
    exports: EditExport[];
}

export interface EditResult {
    jobId: string;
    outputDir: string;
    source: LoadedSource;
    /** The transformed still timeline, when the source consists of frames. */
    stills?: SourceFrame[];
    video?: { path: string; info: VideoInfo };
    /** Every candidate frame with its keep decision. */
    frames: EditFrame[];
    kept: EditFrame[];
    sheets: EditSheet[];
    exports: EditExport[];
    steps: StepReport[];
}

export interface EditRunOptions {
    /** The job's folder; overrides the plan's `output`. */
    outputDir?: string;
    /** `workspace` (default): each step writes into its own folder under `steps/`, so plans sharing a prefix share
     * its files. `flat`: every file goes straight into the output folder. */
    layout?: "workspace" | "flat";
    /** Default true: a rerun of the same plan on the same source skips the finished steps. */
    receipts?: boolean;
    signal?: AbortSignal;
    onProgress?: (event: ProgressEvent) => void;
}

/** A running edit: progress events, cancel, and `await job.done` for the artifacts. */
export class EditJob {
    readonly done: Promise<EditResult>;

    constructor(
        readonly job: Job<EditState>,
        readonly outputDir: string
    ) {
        this.done = job.done.then(({ state, steps }) => toResult({ state, steps, jobId: job.id, outputDir }));
        this.done.catch((error: unknown) => log.debug({ error, job: job.id }, "edit job failed"));
    }

    get id(): string {
        return this.job.id;
    }

    get events(): ProgressEvent[] {
        return this.job.events;
    }

    on(event: "progress", listener: (event: ProgressEvent) => void): () => void {
        return this.job.on(event, listener);
    }

    cancel(): void {
        this.job.cancel();
    }
}

function toResult(options: { state: EditState; steps: StepReport[]; jobId: string; outputDir: string }): EditResult {
    const { state } = options;

    if (!state.source) {
        throw new Error("The edit ended without a source");
    }

    const frames = state.frames ?? [];
    return {
        jobId: options.jobId,
        outputDir: options.outputDir,
        source: state.source,
        stills: state.stills,
        video: state.video,
        frames,
        kept: frames.filter((frame) => frame.kept),
        sheets: state.sheets,
        exports: state.exports,
        steps: options.steps,
    };
}

function hash(value: unknown): string {
    return createHash("sha256").update(SafeJSON.stringify(value)).digest("hex");
}

/** `<genesis-tools root>/recordings/edits/<source hash>/`: one workspace per source, shared by its plans. */
export function defaultEditsDir(located: LocatedSource): string {
    return genesisToolsDir("recordings", "edits", hash(located.path).slice(0, 16));
}

function frameLabel(mode: "time" | "sample" | "index" | "none", frame: EditFrame, position: number): string {
    switch (mode) {
        case "sample":
            return `${(frame.actualUs / 1_000_000).toFixed(3)} s · sample ${Number(frame.id) + 1}`;
        case "index":
            return `#${position + 1}`;
        case "none":
            return "";
        case "time": {
            const totalMs = Math.round(frame.actualUs / 1000);
            const minutes = Math.floor(totalMs / 60_000);
            const seconds = ((totalMs % 60_000) / 1000).toFixed(1).padStart(4, "0");
            const display = frame.displayId === undefined ? "" : ` · display ${frame.displayId}`;
            return `${String(minutes).padStart(2, "0")}:${seconds}${display}`;
        }
    }
}

/** Timestamps at `fps` across the window, as the frame review samples them. */
export function sampleTimes(options: { fromUs: number; toUs: number; fps: number }): number[] {
    const count = Math.ceil(((options.toUs - options.fromUs) * options.fps) / 1_000_000);
    return Array.from({ length: count }, (_, index) => options.fromUs + (index * 1_000_000) / options.fps);
}

function videoWindow(state: EditState): { fromUs: number; toUs: number } {
    const durationUs = state.video?.info.durationUs ?? 0;
    const fromUs = state.window.fromUs ?? 0;
    const toUs = state.window.toUs ?? durationUs;

    if (
        !Number.isSafeInteger(fromUs) ||
        !Number.isSafeInteger(toUs) ||
        fromUs < 0 ||
        toUs > durationUs ||
        toUs <= fromUs
    ) {
        throw new Error("Choose a nonempty video range within the original duration, in whole microseconds");
    }

    return { fromUs, toUs };
}

async function extractVideoFrames(ctx: StepContext<EditState>, dir: string, fps: number): Promise<EditFrame[]> {
    const video = ctx.state.video;

    if (!video) {
        throw new Error("No video to sample");
    }

    const { fromUs, toUs } = videoWindow(ctx.state);
    const requestedUs = sampleTimes({ fromUs, toUs, fps });
    const sourceUs = await readVideoFrameTimes({ input: video.path, signal: ctx.signal });
    const samples = locateVideoSamples({ requestedUs, sourceUs });
    const indices = [...new Set(samples.map((sample) => sample.sourceIndex))];

    if (indices.length * video.info.displayWidth * video.info.displayHeight * 4 > FRAME_BUDGET_BYTES) {
        throw new Error("Full-resolution frames exceed the 1 GiB preparation budget; select a lower FPS");
    }

    mkdirSync(dir, { recursive: true });
    ctx.progress({ done: 0, total: samples.length, unit: "frames", message: "extracting" });
    const expression = frameSelectExpression(indices);
    for (const position of indices.keys()) {
        ctx.claim(join(dir, `source-${String(position).padStart(5, "0")}.png`));
    }

    await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-i",
            video.path,
            "-map",
            "0:v:0",
            "-an",
            "-vf",
            `select='${expression}',format=rgba`,
            "-fps_mode",
            "vfr",
            "-start_number",
            "0",
            "-threads",
            "2",
            ctx.claim(join(dir, "source-%05d.png")),
        ],
        signal: ctx.signal,
    });
    const names = new Map(indices.map((index, position) => [index, `source-${String(position).padStart(5, "0")}.png`]));
    return samples.map((sample, position) => {
        const path = join(dir, names.get(sample.sourceIndex) ?? "");

        if (!existsSync(path)) {
            throw new Error("Decoder did not produce every selected source frame");
        }

        return {
            id: String(position),
            requestedUs: sample.requestedUs,
            actualUs: sample.actualUs,
            sourceIndex: sample.sourceIndex,
            path,
            kept: true,
            differencePct: null,
            comparedToId: null,
        };
    });
}

/**
 * ffmpeg `select` expression that keeps exactly these source frames. ffmpeg's parser refuses a flat sum of more than
 * 100 terms (exit 244, "Error while parsing expression"), so the sum is a balanced tree that nests log2(n) deep.
 */
export function frameSelectExpression(indices: readonly number[]): string {
    if (indices.length === 0) {
        return "0";
    }

    if (indices.length === 1) {
        return `eq(n,${indices[0]})`;
    }

    const middle = Math.floor(indices.length / 2);
    return `(${frameSelectExpression(indices.slice(0, middle))}+${frameSelectExpression(indices.slice(middle))})`;
}

function stillFrames(state: EditState, step: { fps?: number; displays?: number[] }): EditFrame[] {
    const fromUs = state.window.fromUs ?? 0;
    const toUs = state.window.toUs ?? Number.POSITIVE_INFINITY;
    // A sampled window starts with the frame already on screen at its start, so the frames before it stay candidates;
    // an unsampled one lists only the frames inside it.
    const inWindow = (state.stills ?? []).filter(
        (frame) =>
            frame.atUs <= toUs &&
            (!step.displays || (frame.displayId !== undefined && step.displays.includes(frame.displayId)))
    );
    let chosen: Array<SourceFrame & { requestedUs?: number }> = inWindow.filter((frame) => frame.atUs >= fromUs);

    if (step.fps !== undefined && inWindow.length > 0) {
        const end = Number.isFinite(toUs) ? toUs : inWindow[inWindow.length - 1].atUs + 1;
        const byDisplay = new Map<number, SourceFrame[]>();

        for (const frame of inWindow) {
            const key = frame.displayId ?? -1;
            const group = byDisplay.get(key);

            if (group) {
                group.push(frame);
            } else {
                byDisplay.set(key, [frame]);
            }
        }

        chosen = [...byDisplay.values()]
            .flatMap((frames) =>
                sampleTimes({ fromUs, toUs: end, fps: step.fps ?? 1 }).flatMap((time) => {
                    const shown = frames.findLast((frame) => frame.atUs <= time);
                    return shown ? [{ ...shown, requestedUs: time }] : [];
                })
            )
            .sort((a, b) => (a.requestedUs ?? a.atUs) - (b.requestedUs ?? b.atUs));
    }

    return chosen.map((frame, position) => ({
        id: String(position),
        requestedUs: frame.requestedUs,
        actualUs: frame.atUs,
        path: frame.path,
        displayId: frame.displayId,
        kept: true,
        differencePct: null,
        comparedToId: null,
    }));
}

async function compareFrames(ctx: StepContext<EditState>, threshold: number): Promise<EditFrame[]> {
    const frames = ctx.state.frames ?? [];
    const guards = new Map<number, FrameDifferenceGuard>();
    const video = ctx.state.video?.info;
    const result: EditFrame[] = [];

    for (const [index, frame] of frames.entries()) {
        ctx.signal.throwIfAborted();

        if (!frame.kept) {
            result.push(frame);
            continue;
        }

        const image = await decodeImageRgba(frame.path);

        if (
            video &&
            ctx.state.source?.kind === "video" &&
            (image.width !== video.displayWidth || image.height !== video.displayHeight)
        ) {
            throw new Error("Decoded dimensions do not match normalized video rotation");
        }

        // Each display is its own picture: a frame is compared with the last kept frame of the same display.
        const key = frame.displayId ?? -1;
        const guard = guards.get(key) ?? new FrameDifferenceGuard({ minimumDifferencePct: threshold });
        guards.set(key, guard);
        result.push({ ...frame, ...guard.consider({ id: frame.id, image }) });
        ctx.progress({ done: index + 1, total: frames.length, unit: "frames", message: "comparing" });
    }

    return result;
}

async function composeSheets(
    ctx: StepContext<EditState>,
    dir: string,
    step: Extract<EditStep, { kind: "grid" }>
): Promise<EditSheet[]> {
    const kept = (ctx.state.frames ?? []).filter((frame) => frame.kept);
    const perImage = Math.min(
        32,
        step.cols && step.rows ? step.cols * step.rows : (step.perImage ?? (step.cols ?? 3) * (step.rows ?? 3))
    );
    const sheets: EditSheet[] = [];
    mkdirSync(dir, { recursive: true });

    for (let offset = 0; offset < kept.length; offset += perImage) {
        ctx.signal.throwIfAborted();
        const group = kept.slice(offset, offset + perImage);
        const path = ctx.claim(join(dir, `sheet-${String(sheets.length + 1).padStart(3, "0")}.png`));
        const grid = await composeImageGrid({
            images: group.map((frame, position) => ({
                path: frame.path,
                label: frameLabel(step.labels, frame, offset + position),
            })),
            output: path,
            columns: step.cols === undefined ? undefined : Math.min(step.cols, group.length),
            maxWidth: step.maxWidth,
            signal: ctx.signal,
        });
        sheets.push({
            path,
            frameIds: group.map((frame) => frame.id),
            firstUs: group[0].actualUs,
            lastUs: group[group.length - 1].actualUs,
            ...grid,
        });
        ctx.progress({
            done: Math.min(offset + perImage, kept.length),
            total: kept.length,
            unit: "frames",
            message: "composing",
        });
    }

    return sheets;
}

async function newVideo(ctx: StepContext<EditState>, command: string[], output: string): Promise<EditState["video"]> {
    ctx.progress({ done: 0, total: 1, unit: "files" });
    await runVideoCommand({ command, signal: ctx.signal, timeoutMs: EXPORT_TIMEOUT_MS });
    ctx.progress({ done: 1, total: 1, unit: "files" });
    return { path: output, info: await probeVideo({ input: output, signal: ctx.signal }) };
}

async function exportStep(
    ctx: StepContext<EditState>,
    dir: string,
    step: Extract<EditStep, { kind: "export" }>
): Promise<EditExport> {
    mkdirSync(dir, { recursive: true });
    const output = ctx.claim(step.output ? resolve(step.output) : join(dir, `export.${step.format}`));
    ctx.progress({ done: 0, total: 1, unit: "files" });

    if (ctx.state.video) {
        await runVideoCommand({
            command: exportVideoArgv({ input: ctx.state.video.path, output, format: step.format, ...ctx.state.window }),
            signal: ctx.signal,
            timeoutMs: EXPORT_TIMEOUT_MS,
        });
    } else {
        const frames = ctx.state.frames?.filter((frame) => frame.kept) ?? stillFrames(ctx.state, {});

        if (frames.length === 0) {
            throw new Error("Nothing to export: no frames in the range");
        }

        if (new Set(frames.map((frame) => frame.displayId)).size > 1) {
            throw new Error("Movie export requires one display; select it in a frames step first");
        }

        const list = ctx.claim(join(dir, `export-${step.format}.ffconcat`));
        const timeline = frames.map((frame) => ({ path: frame.path, atUs: frame.requestedUs ?? frame.actualUs }));
        const last = timeline[timeline.length - 1].atUs;
        const endpoint = ctx.state.window.toUs;
        const sampled = frames.some((frame) => frame.requestedUs !== undefined);
        const sourceEnd = sampled
            ? Math.max(...(ctx.state.stills ?? []).map((frame) => frame.atUs)) + 1
            : last + 1_000_000;
        await Bun.write(list, concatList(timeline, Math.max(1, (endpoint ?? sourceEnd) - last)));
        await runVideoCommand({
            command: exportFramesArgv({ list, output, format: step.format }),
            signal: ctx.signal,
            timeoutMs: EXPORT_TIMEOUT_MS,
        });
    }

    ctx.progress({ done: 1, total: 1, unit: "files" });
    return { path: output, format: step.format };
}

function scaledWindow(window: EditState["window"], factor: number): EditState["window"] {
    return {
        fromUs: window.fromUs === undefined ? undefined : Math.round(window.fromUs / factor),
        toUs: window.toUs === undefined ? undefined : Math.round(window.toUs / factor),
    };
}

/** The job steps of a plan: a source step, then one per plan step (a frames step with changeOnly is two). */
function compile(options: {
    plan: EditPlan;
    located: LocatedSource;
    outputDir: string;
    layout: "workspace" | "flat";
}): JobStep<EditState>[] {
    const { plan, located, outputDir, layout } = options;
    const dirFor = (index: number, kind: string) =>
        layout === "flat"
            ? outputDir
            : join(
                  outputDir,
                  "steps",
                  `${String(index).padStart(2, "0")}-${kind}-${hash([located.fingerprint, plan.steps.slice(0, index + 1)]).slice(0, 12)}`
              );
    const steps: JobStep<EditState>[] = [
        {
            name: "source",
            key: { kind: located.kind },
            run: async (ctx) => {
                ctx.progress({ done: 0, total: 1, unit: "files", message: "probing" });
                const source = await loadSource(located, ctx.signal);
                return {
                    ...ctx.state,
                    source,
                    video: source.kind === "video" ? { path: source.path, info: source.info } : undefined,
                    stills: source.kind === "frames" ? source.frames : undefined,
                };
            },
        },
    ];

    for (const [index, step] of plan.steps.entries()) {
        const dir = dirFor(index, step.kind);
        const key = { index, step };

        switch (step.kind) {
            case "range":
                steps.push({
                    name: `range-${index}`,
                    key,
                    run: async (ctx) => ({ ...ctx.state, window: stepWindow(step) }),
                });
                break;
            case "trim":
                steps.push({
                    name: `trim-${index}`,
                    key,
                    outputs: (state) => (state.video ? [state.video.path] : []),
                    run: async (ctx) => {
                        const window = stepWindow(step);

                        if (!ctx.state.video) {
                            const fromUs = window.fromUs ?? 0;
                            const toUs = window.toUs ?? Number.POSITIVE_INFINITY;
                            // A plain map: the dev-dashboard UI typechecks this file against ES2023, which has no grouping helper on Map.
                            const byDisplay = new Map<number | undefined, NonNullable<typeof ctx.state.stills>>();

                            for (const frame of ctx.state.stills ?? []) {
                                byDisplay.set(frame.displayId, [...(byDisplay.get(frame.displayId) ?? []), frame]);
                            }

                            const stills = [...byDisplay.values()]
                                .flatMap((frames) => {
                                    const predecessor = frames.findLast((frame) => frame.atUs < fromUs);
                                    const selected = frames.filter(
                                        (frame) => frame.atUs >= fromUs && frame.atUs <= toUs
                                    );
                                    return [
                                        ...(predecessor && !selected.some((frame) => frame.atUs === fromUs)
                                            ? [{ ...predecessor, atUs: 0 }]
                                            : []),
                                        ...selected.map((frame) => ({ ...frame, atUs: frame.atUs - fromUs })),
                                    ];
                                })
                                .sort((a, b) => a.atUs - b.atUs);
                            return { ...ctx.state, stills, window: {}, frames: undefined };
                        }

                        const { fromUs, toUs } = videoWindow({ ...ctx.state, window });
                        mkdirSync(dir, { recursive: true });
                        const output = ctx.claim(join(dir, `trim-${index}.mp4`));
                        const video = await newVideo(
                            ctx,
                            trimArgv({ input: ctx.state.video.path, output, fromUs, toUs }),
                            output
                        );
                        return { ...ctx.state, video, window: {}, frames: undefined };
                    },
                });
                break;
            case "speed":
                steps.push({
                    name: `speed-${index}`,
                    key,
                    outputs: (state) => (state.video ? [state.video.path] : []),
                    run: async (ctx) => {
                        if (!ctx.state.video) {
                            const stills = (ctx.state.stills ?? []).map((frame) => ({
                                ...frame,
                                atUs: Math.round(frame.atUs / step.factor),
                            }));
                            return {
                                ...ctx.state,
                                stills,
                                window: scaledWindow(ctx.state.window, step.factor),
                                frames: undefined,
                            };
                        }

                        mkdirSync(dir, { recursive: true });
                        const output = ctx.claim(join(dir, `speed-${index}.mp4`));
                        const audio = await hasAudio(ctx.state.video.path, ctx.signal);
                        const video = await newVideo(
                            ctx,
                            speedArgv({ input: ctx.state.video.path, output, factor: step.factor, audio }),
                            output
                        );
                        return {
                            ...ctx.state,
                            video,
                            window: scaledWindow(ctx.state.window, step.factor),
                            frames: undefined,
                        };
                    },
                });
                break;
            case "frames": {
                const sample =
                    step.fps !== undefined || step.displays !== undefined || plan.steps[index - 1]?.kind !== "frames";

                if (sample) {
                    steps.push({
                        name: `frames-${index}`,
                        key,
                        outputs: (state) => [...new Set((state.frames ?? []).map((frame) => frame.path))],
                        run: async (ctx) => ({
                            ...ctx.state,
                            frames: ctx.state.video
                                ? await extractVideoFrames(ctx, dir, step.fps ?? 2)
                                : stillFrames(ctx.state, step),
                            sheets: [],
                        }),
                    });
                }

                if (step.changeOnly) {
                    steps.push({
                        name: `changes-${index}`,
                        key: { ...key, part: "changes" },
                        run: async (ctx) => ({ ...ctx.state, frames: await compareFrames(ctx, step.threshold ?? 1) }),
                    });
                }

                break;
            }
            case "grid":
                steps.push({
                    name: `grid-${index}`,
                    key,
                    outputs: (state) => state.sheets.map((sheet) => sheet.path),
                    run: async (ctx) => {
                        if (!ctx.state.frames?.some((frame) => frame.kept)) {
                            throw new Error("A grid needs current frames; sample frames after trim or speed");
                        }
                        return { ...ctx.state, sheets: await composeSheets(ctx, dir, step) };
                    },
                });
                break;
            case "export":
                steps.push({
                    name: `export-${index}`,
                    key,
                    outputs: (state) => state.exports.map((one) => one.path),
                    run: async (ctx) => ({
                        ...ctx.state,
                        exports: [...ctx.state.exports, await exportStep(ctx, dir, step)],
                    }),
                });
                break;
        }
    }

    return steps.map((step) => ({
        ...step,
        outputs: (state) => [
            ...new Set([
                ...(state.video ? [state.video.path] : []),
                ...(state.stills ?? []).map((frame) => frame.path),
                ...(state.frames ?? []).map((frame) => frame.path),
                ...state.sheets.map((sheet) => sheet.path),
                ...state.exports.map((output) => output.path),
            ]),
        ],
    }));
}

async function hasAudio(path: string, signal: AbortSignal): Promise<boolean> {
    const raw = await runVideoCommand({
        command: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            path,
        ],
        signal,
        timeoutMs: 30_000,
    });
    return raw.trim().length > 0;
}

/**
 * Cuts a recording into frames, change-only frames, image grids, trims, speed changes and exports, as steps of one
 * job. It never writes an input, and a rerun of a plan on an unchanged source skips the steps its receipts cover.
 */
const workspaceJobs = new Map<string, Promise<unknown>>();

export class RecordingEditor {
    constructor(private readonly options: { registry?: JobRegistry } = {}) {}

    /** Validates the plan (throws a ZodError naming the wrong field) and starts the job. */
    run(input: EditPlanInput, options: EditRunOptions = {}): EditJob {
        const plan = parseEditPlan(input);
        const located = locateSource(plan.source);
        const outputDir = resolve(options.outputDir ?? plan.output ?? defaultEditsDir(located));
        const receipts = options.receipts ?? true;
        const previous = workspaceJobs.get(outputDir);
        const steps = compile({ plan, located, outputDir, layout: options.layout ?? "workspace" });
        log.debug({ source: located.path, outputDir, steps: steps.map((step) => step.name) }, "edit job starting");
        const job = runJob<EditState>({
            kind: "edit",
            initial: { window: {}, sheets: [], exports: [] },
            steps: [
                {
                    name: "workspace",
                    key: { layout: options.layout ?? "workspace" },
                    run: async (ctx) => {
                        await previous;
                        mkdirSync(ctx.claim(outputDir), { recursive: true });
                        return ctx.state;
                    },
                },
                ...steps,
            ],
            inputs: [
                located.path,
                ...(located.kind === "frames"
                    ? [
                          join(located.path, RECORDING_MANIFEST),
                          ...readFrameFolder(located.path).map((frame) => frame.path),
                      ]
                    : []),
            ],
            receipts: receipts ? join(outputDir, ".receipts") : undefined,
            fingerprint: located.fingerprint,
            signal: options.signal,
            onProgress: options.onProgress,
            registry: this.options.registry,
        });
        const settled = job.done.catch((error: unknown) => {
            log.debug({ error, outputDir }, "previous workspace job failed");
        });
        workspaceJobs.set(outputDir, settled);
        void settled.then(() => {
            if (workspaceJobs.get(outputDir) === settled) {
                workspaceJobs.delete(outputDir);
            }
        });
        return new EditJob(job, outputDir);
    }
}
