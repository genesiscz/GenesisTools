import { randomUUID } from "node:crypto";
import { abortableSleep } from "@genesiscz/utils/async";
import { type JobInfo, JobRegistry, type JobStep } from "@genesiscz/utils/jobs";
import { logger } from "@genesiscz/utils/logger";
import {
    type AudioDevices,
    type AudioSource,
    type AudioState,
    type DisplayEntry,
    type DisplayMode,
    type DisplaySelection,
    RecorderControl,
    type RecorderMethod,
    type RecorderSettings,
    type RecorderSettingsPatch,
    type RecorderState,
    type RecorderStatus,
    RPC_ERRORS,
    RpcError,
    type SettingsAnswer,
    type StopAnswer,
} from "./control";
import { DisplayBook, type DisplayInterval } from "./display-book";
import type { DisplayChoice } from "./display-choice";
import { type RecordingFinish, runRecordingFinish } from "./finish";
import { type LiveEntry, type LiveEntryChange, type LiveEvent, LiveRecordingServer } from "./live";
import {
    type AudioOwnership,
    PieceCaptures,
    type PieceCapturesOptions,
    type PieceOutcome,
    type SessionCapture,
    type SettingsChange,
    type SettingsScope,
} from "./session";
import type { PieceTarget } from "./targets";
import { CaptureError, type CaptureRequest, type FrameRecorder, MAX_CAPTURE_SECONDS } from "./types";

const { log } = logger.scoped("screen-recorder-recording");

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

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
/** The methods every frame recording serves; a kind adds its own (the library recording's `discard`). */
export const FRAME_RECORDING_METHODS = [
    "status",
    "pause",
    "resume",
    "stop",
    "displays.list",
    "displays.add",
    "displays.remove",
    "displays.switch",
    "displays.mode",
    "jobs.list",
    "audio.list",
    "audio.mute",
    "audio.setInput",
    "settings.get",
    "settings.set",
] as const satisfies readonly RecorderMethod[];

/**
 * A verdict rule for the meetings recorder: only a capture that threw a `CaptureError` fails a piece (a missing
 * display included); any other error (a frame that cannot be converted) ends the recording. A piece cut by a pause or
 * a stop is neither.
 */
export function captureErrorVerdict(piece: PieceResult, now: { paused: boolean; stopping: boolean }): PieceVerdict {
    const { outcome, error } = piece;
    const failure =
        error ?? (outcome && !outcome.recorded && !now.paused && !now.stopping ? outcome.lastError : undefined);

    if (failure === undefined) {
        return outcome?.recorded ? "recorded" : "neither";
    }

    if (failure instanceof CaptureError) {
        return "failed";
    }

    throw failure;
}

/** A verdict rule for the library recording: a piece that kept no frame failed, whatever the cause; an error ends it. */
export function emptyPieceVerdict(piece: PieceResult): PieceVerdict {
    if (piece.error !== undefined) {
        throw piece.error;
    }

    return piece.outcome && piece.outcome.frames > 0 ? "recorded" : "failed";
}

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

/** The keys of a capture request a kind adds beside the shared settings (its recorder's own). */
export type PieceRequestExtras = Partial<Omit<CaptureRequest, "target" | "outDir" | "hooks" | "audio" | "durationSec">>;

/** How the live calls of a kind answer where the recorders differ. */
export interface RecorderControlsConfig {
    /**
     * `refused`: once it stops, a second stop and every change are refused. `answered`: a second stop answers with the
     * same finish, and a change still applies.
     */
    whileStopping: "refused" | "answered";
    /** The error code a sound call answers for a source (or the microphone) this recording does not record. */
    unrecordedSource: number;
    settings: {
        scope: SettingsScope;
        /** Which live commands a change needs: `settingsChange` (by value) or `patchChange` (by the keys given). */
        change: (before: RecorderSettings, after: RecorderSettings, patch: RecorderSettingsPatch) => SettingsChange;
    };
}

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
    /** The recorded displays changed, or an interval opened or closed (a state file follows them). */
    onDisplays?: () => void;
    /**
     * What the kind does with each capture (its frames, its errors, its files), after the core kept its display
     * intervals.
     */
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
        /**
         * The displays the entry names, which the kind then keeps up to date. Without it the entry names the displays
         * of the running captures.
         */
        displays?: () => Array<{ id: number; name: string }>;
    };
    /** What an earlier run of the same recording saw: its display intervals and the names of its displays. */
    history?: { intervals?: readonly DisplayInterval[]; names?: Iterable<[number, string]> };
    /** What the captures and the OCR use at the start; `settings.set` changes it while the recording runs. */
    settings: RecorderSettings;
    /** The sound it records; a recorder without sound records none. */
    audio: AudioState;
    /** SIGTERM and SIGINT stop the recording while its captures run (a recorder process of its own). */
    stopOnSignals?: boolean;
    /** Which displays it records, and what the display calls do. */
    displays: DisplayChoice;
    /** The frames the kind has kept so far; the live count adds those the running captures announced. */
    keptFrames: () => number;
    pieces: {
        dir: string;
        /** The length of one piece; at most `MAX_CAPTURE_SECONDS`. */
        sec: number;
        /** The recording ends by itself this long after its start; without it, it runs until a stop. */
        maxMs?: number;
        audioOwnership: AudioOwnership;
        /** The recorder's own keys of a capture that starts now (read at its start). */
        request?: (settings: RecorderSettings) => PieceRequestExtras;
        failures: PieceFailureRule;
    };
    controls: RecorderControlsConfig;
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
    /** Which displays it records and when. */
    readonly displayBook: DisplayBook;
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
    private current: RecorderSettings;
    private sound: AudioState;

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
        this.current = config.settings;
        this.sound = config.audio;
        this.displayBook = new DisplayBook(config.history);
        const kind = config.hooks.captures;
        this.captures = new PieceCaptures({
            capture: (request, signal) => this.managed().capture(request, signal),
            pieceDir: config.pieces.dir,
            request: () => ({
                activeFps: this.current.activeFps,
                idleFps: this.current.idleFps,
                thresholdPercent: this.current.threshold,
                maxLongSidePx: this.current.maxLongSide,
                ...config.pieces.request?.(this.current),
                durationSec: this.pieceSec,
            }),
            // A muted source is left out of a new capture, so its start-up buffers never reach the file; unmuting
            // restarts the captures with it.
            audio: () => {
                const sources = this.sound.sources.filter((source) => !this.sound.muted[source]);
                return config.recorder.supports.audio && sources.length > 0
                    ? { sources, ...(this.sound.micDevice ? { micDeviceId: this.sound.micDevice } : {}) }
                    : undefined;
            },
            audioOwnership: config.pieces.audioOwnership,
            hooks: {
                // The displays first: opening the interval saves the kind's state, which then names every display.
                onStart: (capture) => {
                    this.syncDisplays();
                    this.openDisplay(capture, capture.target.displayId);
                    // The interval ends when the capture is told to stop, not when its post-processing ends.
                    capture.controller.signal.addEventListener("abort", () => this.closeDisplay(capture), {
                        once: true,
                    });
                    kind.onStart?.(capture);
                },
                onFrame: (capture, frame) => {
                    const displayId = frame.displayId ?? capture.target.displayId;

                    if (!capture.controller.signal.aborted) {
                        this.openDisplay(capture, displayId);
                    }

                    // Frames count as they land; the kind keeps them when the capture returns.
                    const at = new Date().toISOString();
                    capture.streamed += 1;
                    this.update({ frames: this.liveFrames(), lastFrameAt: at });
                    this.emit("frame", { displayId, at, file: frame.path });
                    kind.onFrame?.(capture, frame);
                },
                onLive: (_capture, channel) => {
                    if (this.phase === "paused") {
                        channel.pause();
                    }
                },
                onResult: async (capture, result) => {
                    this.displayBook.align(capture, result);
                    this.closeDisplay(capture);

                    try {
                        return await kind.onResult?.(capture, result);
                    } finally {
                        // Its frames are the kind's now (kept, or dropped with an error).
                        capture.streamed = 0;
                        this.update({ frames: this.liveFrames() });
                    }
                },
                onError: (capture, error, outcome) => {
                    this.closeDisplay(capture);
                    kind.onError?.(capture, error, outcome);
                },
                onSettled: kind.onSettled,
            },
        });
    }

    /** The recorded displays follow the running captures. */
    private syncDisplays(): void {
        const before = this.displayBook.recorded?.map((one) => one.id).join(",") ?? "";

        if (!this.displayBook.sync(this.captures.running)) {
            return;
        }

        const recorded = this.displayBook.recorded ?? [];
        log.info({ from: before, to: recorded.map((one) => one.id).join(",") }, "recorded displays changed");

        if (!this.config.live.displays) {
            this.update({ displays: recorded });
        }

        this.config.hooks.onDisplays?.();
    }

    /** The capture records `displayId` from now (a start, a live switch, a frame of another display). */
    private openDisplay(capture: SessionCapture, displayId: number): void {
        if (this.displayBook.open(capture, displayId)) {
            this.config.hooks.onDisplays?.();
        }
    }

    /** The frames kept so far and those each running capture announced and has not returned yet. */
    liveFrames(): number {
        return (
            this.config.keptFrames() + [...this.captures.running.values()].reduce((sum, one) => sum + one.streamed, 0)
        );
    }

    private closeDisplay(capture: SessionCapture): void {
        this.displayBook.close(capture);
        this.config.hooks.onDisplays?.();
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

    get recorder(): FrameRecorder {
        return this.config.recorder;
    }

    /** What the captures and the OCR use now. */
    get settings(): RecorderSettings {
        return this.current;
    }

    /** The sound it records now (a copy). */
    get audio(): AudioState {
        return { ...this.sound, muted: { ...this.sound.muted } };
    }

    /** A recorder that turned out to have no sound: the recording records frames only. */
    protected recordNoSound(): void {
        this.sound = { ...this.sound, sources: [] };
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
        if (this.stopRequested && this.config.controls.whileStopping === "refused") {
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

    override async getSettings(): Promise<SettingsAnswer> {
        return { settings: this.current, audio: this.audio };
    }

    override async setSettings(patch: RecorderSettingsPatch): Promise<SettingsAnswer> {
        this.refuseWhileStopping();
        const before = this.current;
        this.current = { ...before, ...patch, ocr: { ...before.ocr, ...patch.ocr } };
        // Each capture takes the change live or restarts (the scope says which); ax-tool has no live heartbeat
        // command, so a change of it restarts. No capture running: the next piece takes it.
        const applied = await this.captures
            .applySettings({
                change: this.config.controls.settings.change(before, this.current, patch),
                settings: this.current,
                scope: this.config.controls.settings.scope,
            })
            .catch((error: unknown) => {
                // A capture refused it: the old settings stay, and every capture restarts with them, also one that
                // took part of the change live already.
                this.current = before;
                this.captures.abortAll();
                throw error;
            });
        log.info({ id: this.config.live.id, settings: this.current, applied }, "recorder settings changed");
        return { settings: this.current, audio: this.audio, applied };
    }

    override async listAudioDevices(): Promise<AudioDevices> {
        try {
            return await this.config.recorder.audioDevices();
        } catch (error) {
            throw new RpcError(RPC_ERRORS.unsupported, errorText(error));
        }
    }

    override async muteAudio(source: AudioSource, muted: boolean): Promise<AudioState> {
        this.refuseWhileStopping();

        if (!this.sound.sources.includes(source)) {
            throw new RpcError(this.config.controls.unrecordedSource, `this recording records no ${source} sound`);
        }

        if (this.sound.muted[source] === muted) {
            return this.audio;
        }

        // The running captures were started without the muted source: only new captures can add it.
        if (!muted) {
            this.sound = { ...this.sound, muted: { ...this.sound.muted, [source]: false } };
            log.info({ id: this.config.live.id, source }, "audio unmuted; the piece restarts");
            this.captures.abortAll();
            return this.audio;
        }

        const owners = [...this.captures.running.values()].filter((one) => one.audio);

        if (owners.some((one) => !one.live?.mute)) {
            throw new RpcError(RPC_ERRORS.unsupported, `the running capture cannot mute ${source}`);
        }

        await Promise.all(owners.map((one) => one.live?.mute?.(source, true))).catch((error: unknown) => {
            throw new RpcError(RPC_ERRORS.internal, errorText(error));
        });
        this.sound = { ...this.sound, muted: { ...this.sound.muted, [source]: true } };
        log.info({ id: this.config.live.id, source }, "audio muted");
        return this.audio;
    }

    override async setAudioInput(deviceId: string): Promise<AudioState> {
        this.refuseWhileStopping();

        if (!this.sound.sources.includes("mic")) {
            throw new RpcError(this.config.controls.unrecordedSource, "this recording records no microphone");
        }

        const devices = await this.listAudioDevices();

        if (!devices.inputs.some((device) => device.id === deviceId)) {
            throw new RpcError(RPC_ERRORS.unknownDevice, `no input device ${deviceId}; see audio.list`);
        }

        this.sound = { ...this.sound, micDevice: deviceId };
        const owners = [...this.captures.running.values()].filter((one) => one.audio);

        if (owners.length > 0 && owners.every((one) => one.live?.setMic)) {
            await Promise.all(owners.map((one) => one.live?.setMic?.(deviceId))).catch((error: unknown) => {
                throw new RpcError(RPC_ERRORS.internal, errorText(error));
            });
        } else {
            // The captures restart, so those that record the sound again use the new microphone.
            this.captures.abortAll();
        }

        return this.audio;
    }

    override listDisplays(): Promise<DisplayEntry[]> {
        return this.config.displays.list(this);
    }

    override addDisplay(displayId: number): Promise<DisplaySelection> {
        return this.config.displays.add(this, displayId);
    }

    override removeDisplay(displayId: number): Promise<DisplaySelection> {
        return this.config.displays.remove(this, displayId);
    }

    override switchDisplay(displayId: number): Promise<DisplaySelection> {
        return this.config.displays.switchTo(this, displayId);
    }

    override setDisplayMode(mode: DisplayMode): Promise<DisplaySelection> {
        return this.config.displays.mode(this, mode);
    }

    /**
     * Moves the running capture onto another display without a restart, when it has a live channel: the other
     * captures end. `none`: no capture can; `ended`: the capture ended while the switch was in flight.
     */
    async switchLive(target: PieceTarget): Promise<"live" | "ended" | "none"> {
        const [only, ...others] = [...this.captures.running.values()];

        if (!only?.live || only.target.target.kind !== "display") {
            return "none";
        }

        try {
            await only.live.switchDisplay(target.displayId);
        } catch (error) {
            throw new RpcError(
                error instanceof CaptureError && error.kind === "display-missing"
                    ? RPC_ERRORS.unknownDisplay
                    : RPC_ERRORS.internal,
                errorText(error)
            );
        }

        if (this.captures.running.get(only.target.displayId) !== only) {
            return "ended";
        }

        for (const other of others) {
            other.controller.abort();
        }

        this.captures.running.delete(only.target.displayId);
        only.target = target;
        this.openDisplay(only, target.displayId);
        this.captures.running.set(target.displayId, only);
        this.syncDisplays();
        return "live";
    }

    /** A change while it stops: refused by a kind that refuses changes then (`controls.whileStopping`). */
    refuseWhileStopping(): void {
        if (this.config.controls.whileStopping === "refused" && this.stopping) {
            throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is stopping");
        }
    }

    private managed(): ManagedRecording {
        if (!this.session) {
            throw new Error("the recording has not started");
        }

        return this.session;
    }

    private async run(): Promise<void> {
        const { hooks } = this.config;
        const onSignal = () => this.requestStop();

        if (this.config.stopOnSignals) {
            process.on("SIGTERM", onSignal);
            process.on("SIGINT", onSignal);
        }

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
            process.off("SIGTERM", onSignal);
            process.off("SIGINT", onSignal);
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
            const targets = await this.config.displays.targets(this);

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
