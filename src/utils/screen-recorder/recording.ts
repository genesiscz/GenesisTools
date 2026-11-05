import { randomUUID } from "node:crypto";
import { abortableSleep } from "@genesiscz/utils/async";
import { type JobInfo, JobRegistry, type JobStep } from "@genesiscz/utils/jobs";
import { logger } from "@genesiscz/utils/logger";
import {
    RecorderControl,
    type RecorderMethod,
    type RecorderState,
    type RecorderStatus,
    RPC_ERRORS,
    RpcError,
    type StopAnswer,
} from "./control";
import { type RecordingFinish, runRecordingFinish } from "./finish";
import { type LiveEntry, type LiveEntryChange, type LiveEvent, LiveRecordingServer } from "./live";
import {
    type AudioOwnership,
    PieceCaptures,
    type PieceCapturesOptions,
    type PieceOutcome,
    type SessionCapture,
} from "./session";
import type { PieceTarget } from "./targets";
import { CaptureError, type CaptureRequest, type FrameRecorder, MAX_CAPTURE_SECONDS } from "./types";

const { log } = logger.scoped("screen-recorder-recording");

/**
 * One recording of a frame recorder, run the same way for every kind (the meetings recorder, the library recording):
 * the live socket, the pieces one after the other (pause and resume, the stop, the failure backoff, the piece length)
 * and the ordered finish. A kind plugs in through its `RecorderConfig`: what each piece records, what a piece's outcome
 * means, what it keeps of the frames, and its finish steps.
 */

export interface ManagedRecordingOptions {
    /** Readiness the caller already established, so a capture does not prepare the same recorder twice. */
    readiness?: Promise<void>;
    recorder: FrameRecorder;
    session: ConstructorParameters<typeof LiveRecordingServer>[0];
}

/** The live socket of a recording and the recorder behind it, prepared once. */
export class ManagedRecording {
    readonly live: LiveRecordingServer;
    private readiness?: Promise<void>;

    constructor(private readonly options: ManagedRecordingOptions) {
        this.live = new LiveRecordingServer(options.session);
        this.readiness = options.readiness;
    }

    ready(): Promise<void> {
        this.readiness ??= this.options.recorder.available().then((available) => {
            if (!available.ok) {
                throw new CaptureError(
                    "unavailable",
                    `the ${this.options.recorder.id} recorder is not available: ${available.reason}`
                );
            }
        });
        return this.readiness;
    }

    async capture(...args: Parameters<FrameRecorder["capture"]>): ReturnType<FrameRecorder["capture"]> {
        args[1]?.throwIfAborted();
        await this.ready();
        args[1]?.throwIfAborted();
        return this.options.recorder.capture(...args);
    }
}

/** How a piece went for a kind's failure rule: it recorded, it failed, or neither (a pause or a stop came). */
export type PieceVerdict = "recorded" | "failed" | "neither";

/** What a piece came to: its outcome, or the error its planning or the piece threw. */
export interface PieceResult {
    outcome?: PieceOutcome;
    error?: unknown;
}

/** When failed pieces end a recording, and how long it waits after one. */
export interface PieceFailureRule {
    /** Failed pieces in a row after which the recording ends. */
    max: number;
    /** The wait after a failed piece; a stop cuts it short. */
    pauseMs: number;
    /** The verdict on a piece. Throwing ends the recording with that error (`hooks.onError`). */
    verdict(piece: PieceResult, now: { paused: boolean; stopping: boolean }): PieceVerdict;
    /** `max` pieces failed in a row, so the recording ends; `error` is the last failure's. */
    gaveUp(count: number, error: unknown): void;
    /** A piece recorded. */
    recorded?(): Promise<void>;
}

/** The settings of a capture that starts now, all but its length (the core gives each piece its length). */
export type PieceRequest = Omit<CaptureRequest, "target" | "outDir" | "hooks" | "audio" | "durationSec">;

export interface RecorderHooks {
    /** Before the first piece, once the socket listens; a throw ends the recording (`onError`). */
    beforeLoop?: () => Promise<void> | void;
    /** After the last piece, before the finish. */
    afterLoop?: () => void;
    /** `beforeLoop`, a piece or a verdict threw: the recording ends and finishes. */
    onError?: (error: unknown) => void;
    /** `at`: when the pause was asked for; the running piece converts its frames after that. */
    onPaused?: (at: string) => void;
    onResumed?: () => void;
    /** After each piece that did not end the recording. */
    afterPiece?: () => void;
    /** What the kind does with each capture (its frames, its errors, its files). */
    captures: Omit<PieceCapturesOptions["hooks"], "onLive">;
}

export interface RecorderFinishConfig<S> {
    kind: string;
    /** The finish job's id; one is made when it is omitted. */
    id?: string;
    initial: S;
    /**
     * The name of a first step that waits for the captures to end, so the finish (and its job) starts with the stop.
     * Without it the finish starts once the captures have ended.
     */
    capturesStep?: string;
    steps: JobStep<S>[];
    answer: (state: S, job: string) => StopAnswer;
    /** The stop answer when a step threw; without it a waiting stop fails with the step's error. */
    failed?: (error: unknown, job: string) => StopAnswer;
    /** Why the recording ended, for the socket's `ended` event. */
    closeReason: () => string | undefined;
    /**
     * Set: a waiting stop gets the answer at once and the socket closes this long after. Unset: a waiting stop settles
     * once the socket has closed (the socket still delivers the answer).
     */
    closeAfterMs?: number;
}

/** Everything a recorder kind decides; the rest of the run is the core's. */
export interface RecorderConfig<S> {
    kind: string;
    methods: readonly RecorderMethod[];
    recorder: FrameRecorder;
    /** Readiness the caller already established. */
    readiness?: Promise<void>;
    live: {
        id: string;
        title: string;
        folder: string;
        dir?: string;
        /** The displays the entry names before the first capture. */
        displays?: () => Array<{ id: number; name: string }>;
    };
    pieces: {
        dir: string;
        /** The length of one piece; at most `MAX_CAPTURE_SECONDS`. */
        sec: number;
        /** The recording ends by itself this long after its start; without it, it runs until a stop. */
        maxMs?: number;
        audioOwnership: AudioOwnership;
        request: (target: PieceTarget) => PieceRequest;
        audio: PieceCapturesOptions["audio"];
        /** The captures of the next piece; a throw is the piece's error. */
        targets: () => Promise<PieceTarget[]> | PieceTarget[];
        failures: PieceFailureRule;
    };
    /**
     * `refused`: once it stops, a second stop and every change are refused. `answered`: a second stop answers with the
     * same finish.
     */
    whileStopping: "refused" | "answered";
    hooks: RecorderHooks;
    finish: RecorderFinishConfig<S>;
}

export class FrameRecording<S = unknown> extends RecorderControl {
    readonly kind: string;
    readonly methods: readonly RecorderMethod[];
    readonly startedAt = new Date();
    /** The post-processing jobs (the OCR of a piece, the finish), shown by `jobs.list` and the progress events. */
    readonly jobs: JobRegistry;
    /** The captures of the running piece. */
    readonly captures: PieceCaptures;
    /** Settles once the finish and the socket's close have ended, whoever stopped the recording. */
    readonly finished: Promise<StopAnswer>;
    private session?: ManagedRecording;
    private phase: RecorderState = "recording";
    private stopRequested = false;
    /** The capture loop has ended: the finish runs, nothing changes any more. */
    private ended = false;
    private wake?: () => void;
    private readonly backoff = new AbortController();
    private pieceSec: number;
    private loop?: Promise<void>;
    private finishing?: RecordingFinish;
    private readonly finishJob: string;
    private readonly answered = Promise.withResolvers<StopAnswer>();
    private readonly completed = Promise.withResolvers<StopAnswer>();

    constructor(protected readonly config: RecorderConfig<S>) {
        super();
        this.kind = config.kind;
        this.methods = config.methods;
        this.jobs = new JobRegistry((event) => this.emit("progress", { ...event }));
        this.finishJob = config.finish.id ?? `${config.finish.kind}-${randomUUID().slice(0, 8)}`;
        this.finished = this.completed.promise;
        void this.finished.catch((error: unknown) =>
            log.warn({ error, id: config.live.id }, "the recording's post-processing failed")
        );
        void this.answered.promise.catch(() => undefined);
        this.pieceSec = this.pieceLength();
        this.captures = new PieceCaptures({
            capture: (request, signal) => this.managed().capture(request, signal),
            pieceDir: config.pieces.dir,
            request: (target) => ({ ...config.pieces.request(target), durationSec: this.pieceSec }),
            audio: config.pieces.audio,
            audioOwnership: config.pieces.audioOwnership,
            hooks: {
                ...config.hooks.captures,
                onLive: (_capture, channel) => {
                    if (this.phase === "paused") {
                        channel.pause();
                    }
                },
            },
        });
    }

    /** Opens the live socket and starts recording; the finish follows when the captures end. */
    open(): void {
        const { config } = this;
        this.session = new ManagedRecording({
            recorder: config.recorder,
            readiness: config.readiness,
            session: {
                id: config.live.id,
                kind: config.kind,
                title: config.live.title,
                folder: config.live.folder,
                dir: config.live.dir,
                displays: config.live.displays?.(),
                control: this,
            },
        });
        this.loop = this.run();
        void this.loop.then(() => this.beginFinish());
    }

    get state(): RecorderState {
        return this.phase;
    }

    /** The running captures, by the display each records. */
    get running(): Map<number, SessionCapture> {
        return this.captures.running;
    }

    get paused(): boolean {
        return this.phase === "paused";
    }

    /** A stop was asked for, or the capture loop has ended: the recording only finishes now. */
    get stopping(): boolean {
        return this.stopRequested || this.ended;
    }

    /** The live entry as it is now; undefined before the socket opened. */
    get entry(): LiveEntry | undefined {
        return this.session?.live.current;
    }

    update(change: LiveEntryChange): void {
        this.session?.live.update(change);
    }

    emit(event: LiveEvent, params: Record<string, unknown>): void {
        this.session?.live.emit(event, params);
    }

    async status(): Promise<RecorderStatus> {
        const entry = this.entry;

        if (!entry) {
            throw new RpcError(RPC_ERRORS.internal, "the recording has not started");
        }

        return {
            kind: entry.kind,
            title: entry.title,
            state: entry.state,
            displays: entry.displays,
            frames: entry.frames,
            ...(entry.lastFrameAt ? { lastFrameAt: entry.lastFrameAt } : {}),
            ...(entry.warning ? { warning: entry.warning } : {}),
            ...(entry.folder ? { folder: entry.folder } : {}),
        };
    }

    async pause(): Promise<{ state: RecorderState }> {
        if (this.stopping) {
            throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is stopping");
        }

        if (this.phase === "paused") {
            throw new RpcError(RPC_ERRORS.alreadyPaused, "the recording is already paused");
        }

        const at = new Date().toISOString();
        this.phase = "paused";
        // A capture with a live channel pauses in place; any other ends its piece.
        this.captures.pause();
        this.update({ state: "paused" });
        this.config.hooks.onPaused?.(at);
        return { state: "paused" };
    }

    async resume(): Promise<{ state: RecorderState }> {
        if (this.phase !== "paused" || this.stopping) {
            throw new RpcError(RPC_ERRORS.notPaused, "the recording is not paused");
        }

        this.phase = "recording";
        this.captures.resume();
        this.update({ state: "recording" });
        this.config.hooks.onResumed?.();
        this.wake?.();
        return { state: "recording" };
    }

    async stop(options: { wait?: boolean } = {}): Promise<StopAnswer> {
        if (this.stopRequested && this.config.whileStopping === "refused") {
            throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is already stopping");
        }

        this.requestStop();

        if (options.wait === false) {
            return { state: "stopping", job: this.finishJob };
        }

        return this.answered.promise;
    }

    /** Ends the recording (a stop call, a signal): the running captures return what they kept, and the finish follows. */
    requestStop(): void {
        this.stopRequested = true;
        this.phase = "stopping";
        this.update({ state: "stopping" });
        this.captures.abortAll();
        this.backoff.abort();
        this.wake?.();

        if (this.config.finish.capturesStep) {
            this.beginFinish();
        }
    }

    override async listJobs(): Promise<JobInfo[]> {
        return this.jobs.list();
    }

    private managed(): ManagedRecording {
        if (!this.session) {
            throw new Error("the recording has not started");
        }

        return this.session;
    }

    private async run(): Promise<void> {
        const { hooks } = this.config;

        try {
            await hooks.beforeLoop?.();
            await this.managed().ready();
            await this.capturePieces();
        } catch (error) {
            log.debug({ error, id: this.config.live.id }, "the recording's capture loop ended on an error");
            hooks.onError?.(error);
        } finally {
            this.ended = true;
            this.phase = "stopping";
            this.update({ state: "stopping" });
            hooks.afterLoop?.();
        }
    }

    private async capturePieces(): Promise<void> {
        const rule = this.config.pieces.failures;
        let failures = 0;

        while (!this.stopRequested && this.remainingMs() > 0) {
            if (this.phase === "paused") {
                await this.whilePaused();
                continue;
            }

            const piece = await this.capturePiece();
            const now = { paused: this.paused, stopping: this.stopping };
            const verdict = piece ? rule.verdict(piece, now) : "neither";

            if (verdict === "recorded") {
                failures = 0;
                await rule.recorded?.();
            } else if (verdict === "failed") {
                const error = piece?.error ?? piece?.outcome?.lastError;
                failures += 1;
                log.warn({ err: error, failures, id: this.config.live.id }, "capture piece failed");

                if (failures >= rule.max) {
                    rule.gaveUp(failures, error);
                    return;
                }

                if (rule.pauseMs > 0) {
                    await abortableSleep(rule.pauseMs, this.backoff.signal).catch(() => undefined);
                }
            }

            this.config.hooks.afterPiece?.();
        }
    }

    /** One piece, every target at once; undefined when a pause or a stop came while its targets were read. */
    private async capturePiece(): Promise<PieceResult | undefined> {
        try {
            const targets = await this.config.pieces.targets();

            if (this.paused || this.stopRequested) {
                return undefined;
            }

            this.pieceSec = this.pieceLength();
            // A capture started while the piece runs (a display added over the socket) joins it.
            return { outcome: await this.captures.runPiece(targets) };
        } catch (error) {
            return { error };
        }
    }

    private async whilePaused(): Promise<void> {
        await new Promise<void>((resolve) => {
            const remaining = this.remainingMs();
            const timer = Number.isFinite(remaining) ? setTimeout(resolve, Math.max(0, remaining)) : undefined;
            this.wake = () => {
                clearTimeout(timer);
                resolve();
            };

            if (this.phase !== "paused" || this.stopRequested) {
                this.wake();
            }
        });
        this.wake = undefined;
    }

    private remainingMs(): number {
        const { maxMs } = this.config.pieces;
        return maxMs === undefined ? Number.POSITIVE_INFINITY : maxMs - (Date.now() - this.startedAt.getTime());
    }

    /** The piece length, cut to the time left before the recording's end. */
    private pieceLength(): number {
        const sec = Math.min(this.config.pieces.sec, MAX_CAPTURE_SECONDS);
        const remaining = this.remainingMs();
        return Number.isFinite(remaining) ? Math.min(sec, Math.max(1, Math.ceil(remaining / 1000))) : sec;
    }

    private beginFinish(): void {
        if (this.finishing) {
            return;
        }

        const { finish } = this.config;
        const waitForCaptures: JobStep<S>[] = finish.capturesStep
            ? [
                  {
                      name: finish.capturesStep,
                      run: async (ctx) => {
                          await this.loop;
                          return ctx.state;
                      },
                  },
              ]
            : [];
        const finishing = runRecordingFinish<S>({
            jobs: this.jobs,
            kind: finish.kind,
            id: this.finishJob,
            initial: finish.initial,
            steps: [...waitForCaptures, ...finish.steps],
            answer: finish.answer,
            failed: finish.failed,
            close: () => this.session?.live.close(finish.closeReason()),
            closeAfterMs: finish.closeAfterMs,
        });
        this.finishing = finishing;
        const completed = finishing.closed.then(() => finishing.answer);
        completed.then(this.completed.resolve, this.completed.reject);
        (finish.closeAfterMs === undefined ? completed : finishing.answer).then(
            this.answered.resolve,
            this.answered.reject
        );
    }
}
