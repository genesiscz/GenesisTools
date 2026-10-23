import { existsSync } from "node:fs";
import { mkdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import { type RecordingTarget, recordingTargetSchema } from "./recording-targets";

const { log } = logger.scoped("control-recording-session");

/**
 * The longest movie a session records, in seconds: the widget's video import (`probeVideo`) refuses anything longer
 * than ten minutes, and both hosts hand the movie to it. At the limit the session pauses and waits for the person.
 */
export const RECORDING_SESSION_MAX_SECONDS = 600;

/** The recorder stops a run after 180 s (`validateCaptureOptions`), so a longer recording is a chain of runs. */
export const RECORDING_SEGMENT_MAX_SECONDS = 180;

export const recordingCommandSchema = z.discriminatedUnion("cmd", [
    z.object({ cmd: z.literal("pause") }),
    z.object({ cmd: z.literal("resume") }),
    z.object({ cmd: z.literal("restart") }),
    z.object({ cmd: z.literal("stop") }),
    z.object({ cmd: z.literal("discard") }),
    z.object({ cmd: z.literal("switch"), target: recordingTargetSchema }),
]);

export type RecordingCommand = z.infer<typeof recordingCommandSchema>;

/** One stdin line as a session command, or the reason it is not one. */
export function parseRecordingCommand(line: string): RecordingCommand | { error: string } {
    let value: unknown;
    try {
        value = SafeJSON.parse(line, { strict: true });
    } catch (error) {
        log.debug({ error, line: line.slice(0, 200) }, "recording command is not JSON");
        return { error: `Not a JSON command: ${line.slice(0, 200)}` };
    }

    const parsed = recordingCommandSchema.safeParse(value);
    return parsed.success ? parsed.data : { error: `Unknown command: ${line.slice(0, 200)}` };
}

/** `starting`: a recorder run was asked for and has not written its first frame yet; nothing is in the movie. */
export type RecordingState = "starting" | "recording" | "paused" | "finishing";

/** Why the session is in its state: the person asked, the length limit, or the recorder stopped by itself. */
export type RecordingStateReason = "user" | "limit" | "recorder";

export type RecordingSessionEvent =
    | {
          event: "state";
          state: RecordingState;
          reason: RecordingStateReason;
          target: RecordingTarget;
          elapsedMs: number;
          segments: number;
          limitMs: number;
      }
    | { event: "elapsed"; elapsedMs: number; limitMs: number }
    | { event: "segment"; index: number; path: string; durationMs: number; target: RecordingTarget }
    | { event: "done"; path: string; durationMs: number; segments: number }
    | { event: "discarded" }
    | { event: "error"; message: string; code?: string; fatal: boolean };

/** How one recorder run ended: asked to stop, reached its own deadline, or failed. */
export type SegmentEnd = "stop" | "deadline" | "failure";

export interface SegmentResult {
    /** True when the movie at `output` exists and is complete. */
    ok: boolean;
    endedBy: SegmentEnd;
    /** The recorder's own measure of the movie, when it reported one. */
    durationMs?: number;
    error?: string;
    /** A stable code for a refusal a host handles itself (`screen-recording-denied`). */
    code?: string;
}

/**
 * One recorder run: records `target` into `output` until `maxSeconds` or until `signal` aborts, then finalizes the
 * movie. `onRecording` runs once, when the first frame is in. Resolves after the recorder exited; never rejects for
 * a recording problem (that is `endedBy: "failure"`).
 */
export interface SegmentRecorder {
    record(input: {
        target: RecordingTarget;
        output: string;
        maxSeconds: number;
        signal: AbortSignal;
        onRecording: () => void;
    }): Promise<SegmentResult>;
}

export interface FinishedSegment {
    index: number;
    path: string;
    durationMs: number;
    target: RecordingTarget;
}

/** Joins finished segments into `output`, one H.264 MP4, and returns the joined movie's length. */
export type SegmentJoiner = (input: { segments: FinishedSegment[]; output: string }) => Promise<{ durationMs: number }>;

export type RecordingOutcome = "done" | "discarded" | "failed";

interface ActiveSegment {
    index: number;
    path: string;
    target: RecordingTarget;
    maxSeconds: number;
    /** When the first frame came in; unset while the recorder arms. */
    startedAt?: number;
    /** The reason the `recording` state will carry once the first frame is in. */
    reason: RecordingStateReason;
    controller: AbortController;
    /** Set before this session aborts the run, so its end is not mistaken for a rollover or a failure. */
    stopping: boolean;
    result: Promise<SegmentResult>;
}

export function recordingsDir(...segments: string[]): string {
    return toolDataDir("control", "recordings", ...segments);
}

/**
 * A recording made of segments, one recorder run each. Pause ends the current segment and resume starts a new one
 * with the same target; switch ends it and starts one with the new target; restart drops every segment and starts
 * again; stop joins the segments into one movie; discard deletes them. A run that ends by itself at its 180 s
 * deadline is followed by the next one at once. Commands run one at a time, in arrival order.
 */
export class RecordingSession {
    private state: RecordingState | "ended" = "paused";
    private target: RecordingTarget;
    private readonly segments: FinishedSegment[] = [];
    private current: ActiveSegment | undefined;
    private counter = 0;
    /** Wall time of every finished segment, capped at its run's own limit. */
    private recordedMs = 0;
    private queue: Promise<void> = Promise.resolve();
    private ticker: ReturnType<typeof setInterval> | undefined;
    private settle: (outcome: RecordingOutcome) => void = () => {};
    /** Resolves once with how the session ended. */
    readonly finished: Promise<RecordingOutcome>;
    private readonly limitMs: number;
    private readonly segmentSeconds: number;
    private readonly now: () => number;

    constructor(
        private readonly options: {
            target: RecordingTarget;
            /** The segment folder; created on start, removed when the session ends. */
            directory: string;
            /** Where the joined movie goes. */
            output: string;
            recorder: SegmentRecorder;
            join: SegmentJoiner;
            emit: (event: RecordingSessionEvent) => void;
            maxSeconds?: number;
            segmentSeconds?: number;
            now?: () => number;
            /** Milliseconds between `elapsed` events while recording; 0 sends none. */
            tickMs?: number;
        }
    ) {
        this.target = options.target;
        this.limitMs = Math.round((options.maxSeconds ?? RECORDING_SESSION_MAX_SECONDS) * 1000);
        this.segmentSeconds = Math.min(options.segmentSeconds ?? RECORDING_SEGMENT_MAX_SECONDS, 180);
        this.now = options.now ?? Date.now;
        this.finished = new Promise((resolve) => {
            this.settle = resolve;
        });
    }

    /** Starts the first segment. A first segment that fails without a movie ends the session as `failed`. */
    start(): Promise<void> {
        return this.enqueue(async () => {
            await mkdir(this.options.directory, { recursive: true });
            this.beginSegment("user");
            const tick = this.options.tickMs ?? 1000;
            if (tick > 0) {
                this.ticker = setInterval(() => {
                    if (this.state === "recording") {
                        this.options.emit({ event: "elapsed", elapsedMs: this.elapsedMs(), limitMs: this.limitMs });
                    }
                }, tick);
            }
        });
    }

    command(command: RecordingCommand): Promise<void> {
        return this.enqueue(() => this.apply(command));
    }

    elapsedMs(): number {
        return this.recordedMs + (this.current ? this.liveMs(this.current) : 0);
    }

    /** Time a run has been in the movie: none while it arms, never past its own limit. */
    private liveMs(run: ActiveSegment): number {
        if (run.startedAt === undefined) {
            return 0;
        }

        return Math.min(Math.max(0, this.now() - run.startedAt), run.maxSeconds * 1000);
    }

    private enqueue(work: () => Promise<void> | void): Promise<void> {
        const next = this.queue.then(async () => {
            if (this.state === "ended") {
                return;
            }

            try {
                await work();
            } catch (error) {
                log.warn({ error }, "recording session step failed");
                this.options.emit({ event: "error", message: messageOf(error), fatal: false });
            }
        });
        this.queue = next;
        return next;
    }

    private async apply(command: RecordingCommand): Promise<void> {
        log.info({ command: command.cmd, state: this.state, segments: this.segments.length }, "recording command");
        if (this.state === "finishing") {
            this.options.emit({ event: "error", message: "The recording is already being saved.", fatal: false });
            return;
        }

        switch (command.cmd) {
            case "pause":
                if (this.state === "recording" || this.state === "starting") {
                    await this.stopSegment();
                    this.setState("paused", "user");
                }

                return;
            case "resume":
                if (this.state === "paused") {
                    this.resumeOrRefuse(this.target);
                }

                return;
            case "switch":
                await this.stopSegment();
                this.target = command.target;
                this.resumeOrRefuse(command.target);
                return;
            case "restart":
                await this.stopSegment();
                await this.deleteSegments();
                this.recordedMs = 0;
                this.beginSegment("user");
                return;
            case "stop":
                await this.stopSegment();
                await this.finish();
                return;
            case "discard":
                await this.stopSegment();
                await this.deleteSegments();
                await this.removeDirectory();
                this.options.emit({ event: "discarded" });
                this.end("discarded");
                return;
        }
    }

    private resumeOrRefuse(target: RecordingTarget): void {
        if (this.recordedMs >= this.limitMs) {
            this.setState("paused", "limit");
            this.options.emit({
                event: "error",
                message: `The recording reached its ${formatLimit(this.limitMs)} limit. Stop to keep it, or restart.`,
                code: "limit",
                fatal: false,
            });
            return;
        }

        this.target = target;
        this.beginSegment("user");
    }

    private beginSegment(reason: RecordingStateReason): void {
        this.counter += 1;
        const index = this.counter;
        const path = join(this.options.directory, `segment-${String(index).padStart(3, "0")}.mp4`);
        const maxSeconds = Math.min(this.segmentSeconds, (this.limitMs - this.recordedMs) / 1000);
        const controller = new AbortController();
        const target = this.target;
        const run: ActiveSegment = {
            index,
            path,
            target,
            maxSeconds,
            reason,
            controller,
            stopping: false,
            result: Promise.resolve({ ok: false, endedBy: "failure" }),
        };
        this.current = run;
        log.info({ index, target, maxSeconds }, "recording segment requested");
        this.setState("starting", reason);
        run.result = this.options.recorder
            .record({
                target,
                output: path,
                maxSeconds,
                signal: controller.signal,
                onRecording: () => this.markRecording(run),
            })
            .catch((error: unknown) => ({ ok: false, endedBy: "failure" as const, error: messageOf(error) }));
        void run.result.then((result) => {
            if (!run.stopping) {
                void this.enqueue(() => this.endedByItself(run, result));
            }
        });
    }

    /** The run's first frame is in: from here its time is in the movie. */
    private markRecording(run: ActiveSegment): void {
        if (this.current !== run || run.stopping || run.startedAt !== undefined) {
            return;
        }

        run.startedAt = this.now();
        log.info({ index: run.index }, "recording segment started");
        this.setState("recording", run.reason);
    }

    private async stopSegment(): Promise<void> {
        const run = this.current;
        if (!run) {
            return;
        }

        run.stopping = true;
        run.controller.abort();
        const result = await run.result;
        this.current = undefined;
        this.record(run, result);
    }

    /** Keeps a finished run's movie, or says why there is none. */
    private record(run: ActiveSegment, result: SegmentResult): void {
        const wallMs = this.liveMs(run);
        if (!existsSync(run.path)) {
            if (result.endedBy === "failure" || !result.ok) {
                log.warn({ index: run.index, error: result.error }, "recording segment produced no movie");
            }

            return;
        }

        const segment: FinishedSegment = {
            index: run.index,
            path: run.path,
            durationMs: result.durationMs ?? wallMs,
            target: run.target,
        };
        this.segments.push(segment);
        this.recordedMs += wallMs;
        this.options.emit({ event: "segment", ...segment });
    }

    private async endedByItself(run: ActiveSegment, result: SegmentResult): Promise<void> {
        if (this.current !== run) {
            return;
        }

        this.current = undefined;
        this.record(run, result);
        if (result.endedBy === "deadline" && result.ok) {
            if (this.recordedMs >= this.limitMs) {
                log.info({ recordedMs: this.recordedMs }, "recording reached its limit");
                this.setState("paused", "limit");
                return;
            }

            this.beginSegment("recorder");
            return;
        }

        const message = result.error?.trim() || "The recorder stopped by itself.";
        if (this.segments.length === 0 && this.counter === 1) {
            this.options.emit({ event: "error", message, code: result.code, fatal: true });
            await this.removeDirectory();
            this.end("failed");
            return;
        }

        this.setState("paused", "recorder");
        this.options.emit({ event: "error", message, code: result.code, fatal: false });
    }

    private async finish(): Promise<void> {
        this.setState("finishing", "user");
        if (this.segments.length === 0) {
            this.options.emit({ event: "error", message: "Nothing was recorded.", fatal: true });
            await this.removeDirectory();
            this.end("failed");
            return;
        }

        const ordered = [...this.segments].sort((a, b) => a.index - b.index);
        let durationMs: number;
        if (ordered.length === 1) {
            await rename(ordered[0].path, this.options.output);
            durationMs = ordered[0].durationMs;
        } else {
            ({ durationMs } = await this.options.join({ segments: ordered, output: this.options.output }));
        }

        await this.removeDirectory();
        log.info({ output: this.options.output, segments: ordered.length, durationMs }, "recording saved");
        this.options.emit({ event: "done", path: this.options.output, durationMs, segments: ordered.length });
        this.end("done");
    }

    private async deleteSegments(): Promise<void> {
        for (const segment of this.segments.splice(0)) {
            try {
                await unlink(segment.path);
            } catch (error) {
                log.debug({ error, path: segment.path }, "recording segment already gone");
            }
        }
    }

    private async removeDirectory(): Promise<void> {
        await rm(this.options.directory, { recursive: true, force: true });
    }

    private setState(state: RecordingState, reason: RecordingStateReason): void {
        this.state = state;
        this.options.emit({
            event: "state",
            state,
            reason,
            target: this.target,
            elapsedMs: this.elapsedMs(),
            segments: this.segments.length,
            limitMs: this.limitMs,
        });
    }

    private end(outcome: RecordingOutcome): void {
        this.state = "ended";
        clearInterval(this.ticker);
        this.ticker = undefined;
        this.settle(outcome);
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatLimit(ms: number): string {
    const seconds = Math.round(ms / 1000);
    return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/**
 * ffmpeg arguments that join segments of any sizes into one H.264 MP4 at the first segment's size: each input is
 * scaled to fit, padded with black and given square pixels, then the concat filter chains them. The recorder writes
 * variable frame rate movies (a frame only when something moved), so the output keeps their timestamps.
 */
export function joinSegmentsArgv({
    inputs,
    width,
    height,
    output,
}: {
    inputs: string[];
    width: number;
    height: number;
    output: string;
}): string[] {
    const w = Math.max(2, Math.floor(width / 2) * 2);
    const h = Math.max(2, Math.floor(height / 2) * 2);
    const chains = inputs.map(
        (_, index) =>
            `[${index}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
            `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,settb=AVTB[v${index}]`
    );
    const labels = inputs.map((_, index) => `[v${index}]`).join("");
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        ...inputs.flatMap((input) => ["-i", input]),
        "-filter_complex",
        `${chains.join(";")};${labels}concat=n=${inputs.length}:v=1:a=0[out]`,
        "-map",
        "[out]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-fps_mode",
        "vfr",
        "-movflags",
        "+faststart",
        output,
    ];
}
