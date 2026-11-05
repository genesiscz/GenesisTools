import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type JobInfo, JobRegistry } from "@genesiscz/utils/jobs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    defaultRuleContext,
    graceMinutesFor,
    kickDrainer,
    loadRmConfig,
    moveToTrash,
    planRemoval,
    rmCallerFromRuntime,
} from "@genesiscz/utils/rm";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
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
import { runRecordingFinish } from "./finish";
import {
    type FrameNaming,
    FrameOutput,
    type JpegConverter,
    type OcrRecognizer,
    type OcrSinkKind,
    ocrSinkFor,
} from "./frame-output";
import { RECORDING_MANIFEST, type RecordingManifest, recordingsLibraryDir } from "./library";
import { LiveRecordingServer, liveRecordingId } from "./live";
import { PieceCaptures, patchChange, type SessionCapture } from "./session";
import { displayTarget, type PieceTarget, pickDisplayIds } from "./targets";
import {
    type AudioTrack,
    type CapturedFrame,
    CaptureError,
    type CaptureResult,
    type DisplayInfo,
    type FrameRecorder,
    type LiveCapture,
    MAX_CAPTURE_SECONDS,
} from "./types";

const { log } = logger.scoped("screen-recorder-start");

export interface ManagedRecordingOptions {
    /** Readiness the caller already established, so a capture does not prepare the same recorder twice. */
    readiness?: Promise<void>;
    recorder: FrameRecorder;
    session: ConstructorParameters<typeof LiveRecordingServer>[0];
}

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

export interface StartRecordingOptions {
    recorder: FrameRecorder;
    /** Cancels startup before any recording resources are created. */
    signal?: AbortSignal;
    id?: string;
    title?: string;
    /** `main` (default), `all`, or display ids. */
    displays?: "all" | "main" | number[];
    fps?: number;
    idleFps?: number;
    /** Percent of the frame that must change for a new frame. */
    threshold?: number;
    maxLongSide?: number;
    heartbeatSec?: number;
    audio?: { mic?: boolean; system?: boolean; micDeviceId?: string };
    /** Vision OCR settings for each kept frame. */
    ocr?: Partial<RecorderSettings["ocr"]>;
    /** Where the OCR of each frame goes: `<frame>.ocr.json` beside it (default) or one `ocr.jsonl` row per frame. */
    ocrSink?: OcrSinkKind;
    /**
     * How kept frames are written. Defaults: the recorder's own file, named by elapsed ms, moved when the recording
     * stops. `flush: "piece"` writes each piece's frames (and their OCR) as the piece ends, so they exist while it records.
     */
    frames?: {
        format?: "original" | "jpeg";
        /** 0 to 1; default 0.75 (the meetings default). */
        jpegQuality?: number;
        naming?: FrameNaming;
        flush?: FrameFlush;
    };
    /** Replacements for the JPEG conversion and the OCR (tests). */
    deps?: { convert?: JpegConverter; recognize?: OcrRecognizer };
    /** The recording ends by itself after this long. Default 10 minutes. */
    maxDurationSec?: number;
    /** One capture lasts at most this long before the next one starts. Default 60 s. */
    pieceSec?: number;
    liveDir?: string;
    /** Where the recording's folder goes. Default: the recordings library. */
    folder?: string;
}

interface PendingFrame {
    frame: CapturedFrame;
    displayId: number;
    atMs: number;
    /** Written under `frames/` already (`frames.flush: "piece"`); `frame.path` is its final file. */
    kept?: boolean;
}

/** When a piece's frames are written under `frames/`: as the piece ends, or all at the stop. */
export const FRAME_FLUSHES = ["finish", "piece"] as const;
export type FrameFlush = (typeof FRAME_FLUSHES)[number];

const METHODS: readonly RecorderMethod[] = [
    "status",
    "pause",
    "resume",
    "stop",
    "discard",
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
];

function stamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/**
 * A screen recording of one or more displays into the recordings library, with no meeting attached: frames of
 * the change-aware frame recorder, sound when the recorder has it, controlled over the live recording socket like
 * every other recorder. Post-processing (moving the frames and tracks into place, the manifest) is one job.
 */
export class LibraryRecording extends RecorderControl {
    readonly kind = "library";
    readonly methods = METHODS;
    readonly id: string;
    readonly folder: string;
    readonly startedAt = new Date();
    private server?: LiveRecordingServer;
    private session?: ManagedRecording;
    private readonly jobs = new JobRegistry((event) => this.server?.emit("progress", { ...event }));
    private settings: RecorderSettings;
    private audio: AudioState;
    private state: RecorderState = "recording";
    private chosen: number[] = [];
    private known: DisplayInfo[] = [];
    /** The captures of the running piece (shared capture coordination). */
    private readonly captures: PieceCaptures;
    private readonly running: Map<number, SessionCapture>;
    /** The length of the piece that starts now. */
    private pieceSec = 0;
    private readonly pending: PendingFrame[] = [];
    private readonly tracks: Array<AudioTrack & { displayId: number; startedAtMs: number }> = [];
    private readonly warnings: string[] = [];
    private streamed = 0;
    private stopRequested = false;
    private discarded = false;
    /** The folder was made by this recording's start; only then may discard move it to the trash. */
    private ownsFolder = false;
    private readonly completion = Promise.withResolvers<StopAnswer>();
    /** Settles once post-processing and the live server's cleanup have finished, whoever stopped the recording. */
    readonly finished = this.completion.promise;
    private wake?: () => void;
    private loop?: Promise<void>;
    private finishing?: { job: string; done: Promise<StopAnswer> };
    private readonly output: FrameOutput;
    private readonly flush: FrameFlush;

    constructor(private readonly options: StartRecordingOptions) {
        super();
        // Two recordings started in one second must not share an id, a socket or a folder.
        this.id = options.id ?? liveRecordingId("library", `${stamp(this.startedAt)}-${randomUUID()}`);
        void this.finished.catch((error: unknown) => log.debug({ error, id: this.id }, "recording completion failed"));
        this.folder = options.folder ?? recordingsLibraryDir(this.id);
        this.settings = {
            activeFps: options.fps ?? 2,
            idleFps: options.idleFps ?? 0.5,
            threshold: options.threshold ?? 1,
            maxLongSide: options.maxLongSide ?? 2560,
            heartbeatSec: options.heartbeatSec ?? 0,
            ocr: { enabled: false, languages: ["en-US"], minChars: 20, ...options.ocr },
        };
        const sources: AudioSource[] = [
            ...(options.audio?.mic ? (["mic"] as const) : []),
            ...(options.audio?.system ? (["system"] as const) : []),
        ];
        this.audio = { sources, muted: { mic: false, system: false }, micDevice: options.audio?.micDeviceId };
        const frames = options.frames ?? {};
        this.flush = frames.flush ?? "finish";
        this.captures = new PieceCaptures({
            capture: (request, signal) => this.session!.capture(request, signal),
            pieceDir: join(this.folder, ".pieces"),
            request: () => ({
                durationSec: this.pieceSec,
                activeFps: this.settings.activeFps,
                idleFps: this.settings.idleFps,
                thresholdPercent: this.settings.threshold,
                maxLongSidePx: this.settings.maxLongSide,
                heartbeatSec: this.settings.heartbeatSec || undefined,
            }),
            // Every capture records the sound, without the muted sources.
            audio: () => {
                const sources = this.audio.sources.filter((source) => !this.audio.muted[source]);
                return sources.length > 0 ? { sources, micDeviceId: this.audio.micDevice } : undefined;
            },
            audioOwnership: "every",
            hooks: {
                onFrame: (_entry, frame) => this.onFrame(_entry, frame),
                onLive: (entry, live) => this.onLive(entry, live),
                onResult: (entry, result) => this.onResult(entry, result),
                onError: (entry, error) => {
                    const displayId = entry.startDisplayId;
                    log.warn({ error, displayId }, "a capture of the library recording failed");

                    if (!(error instanceof CaptureError && error.kind === "display-missing")) {
                        this.warn(`display ${displayId}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                },
            },
        });
        this.running = this.captures.running;
        this.output = new FrameOutput({
            folder: this.folder,
            naming: frames.naming ?? "elapsed",
            format:
                frames.format === "jpeg" ? { kind: "jpeg", quality: frames.jpegQuality ?? 0.75 } : { kind: "original" },
            convert: options.deps?.convert,
            ocr: {
                settings: () => this.settings.ocr,
                sink: ocrSinkFor(options.ocrSink ?? "sidecar", this.folder),
                recognize: options.deps?.recognize,
                onError: (error, path) => this.warn(`OCR failed for ${basename(path)}: ${String(error)}`),
            },
        });
    }

    /** Resolves the displays, opens the live socket, and starts recording. */
    async start(): Promise<this> {
        const { recorder } = this.options;
        const available = await recorder.available();
        this.options.signal?.throwIfAborted();

        if (!available.ok) {
            throw new CaptureError("unavailable", available.reason);
        }

        this.known = await recorder.displays();
        this.options.signal?.throwIfAborted();
        this.chosen = this.pick(this.options.displays ?? "main");

        if (this.audio.sources.length > 0 && !recorder.supports.audio) {
            this.warn(`the ${recorder.id} recorder records no sound; recording frames only`);
            this.audio = { ...this.audio, sources: [] };
        }

        this.startedAt.setTime(Date.now());
        // The folder is reserved exclusively: an existing one (another recording, or a user's folder) is refused.
        mkdirSync(dirname(this.folder), { recursive: true });
        mkdirSync(this.folder);
        this.ownsFolder = true;
        mkdirSync(join(this.folder, "frames"));
        // start() checked the recorder's availability above; the captures reuse that answer.
        this.session = startRecording({
            recorder,
            readiness: Promise.resolve(),
            session: {
                id: this.id,
                kind: this.kind,
                title: this.options.title ?? this.id,
                folder: this.folder,
                displays: this.recordedDisplays(),
                control: this,
                dir: this.options.liveDir,
            },
        });
        this.server = this.session.live;
        this.loop = this.run();
        void this.loop
            .then(() => this.stop({ wait: false }))
            .catch((error: unknown) => {
                log.warn({ error, id: this.id }, "library recording automatic stop failed");
            });
        log.info({ id: this.id, displays: this.chosen, recorder: recorder.id }, "library recording started");
        return this;
    }

    private pick(mode: "all" | "main" | number[] | DisplayMode): number[] {
        return pickDisplayIds(mode, this.known);
    }

    private recordedDisplays(): Array<{ id: number; name: string }> {
        return this.chosen.map((id) => ({
            id,
            name: this.known.find((one) => one.id === id)?.name ?? `display ${id}`,
        }));
    }

    private warn(message: string): void {
        this.warnings.push(message);
        this.server?.update({ warning: message });
        log.warn({ id: this.id }, message);
    }

    private restartCaptures(): void {
        this.captures.abortAll();
    }

    private async run(): Promise<void> {
        const maxMs = (this.options.maxDurationSec ?? 600) * 1000;
        const pieceSec = Math.min(this.options.pieceSec ?? 60, MAX_CAPTURE_SECONDS);
        let failures = 0;

        while (!this.stopRequested && Date.now() - this.startedAt.getTime() < maxMs) {
            if (this.state === "paused") {
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, Math.max(0, maxMs - (Date.now() - this.startedAt.getTime())));
                    this.wake = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                });
                this.wake = undefined;
                continue;
            }

            const parallel = this.options.recorder.supports.parallelCaptures;
            const targets = parallel ? this.chosen : this.chosen.slice(0, 1);
            const remainingSec = Math.max(1, Math.ceil((maxMs - (Date.now() - this.startedAt.getTime())) / 1000));
            this.pieceSec = Math.min(pieceSec, remainingSec);
            const outcome = await this.captures.runPiece(targets.map((displayId) => this.targetOf(displayId)));
            failures = outcome.frames > 0 ? 0 : failures + 1;

            if (failures >= 3) {
                this.warn("three captures in a row recorded nothing; the recording ends");
                break;
            }
        }

        this.stopRequested = true;
    }

    private targetOf(displayId: number): PieceTarget {
        const display = this.known.find((one) => one.id === displayId);
        return display
            ? displayTarget(display)
            : { target: { kind: "display", displayId }, displayId, label: `display ${displayId}` };
    }

    private onFrame(entry: SessionCapture, frame: CapturedFrame): void {
        this.streamed += 1;
        this.server?.update({ frames: this.pending.length + this.streamed, lastFrameAt: new Date().toISOString() });
        this.server?.emit("frame", { displayId: frame.displayId ?? entry.startDisplayId, file: frame.path });
    }

    private onLive(entry: SessionCapture, live: LiveCapture): void {
        // The request left the muted sources out, so this finds a source muted between the start and now.
        const sources = entry.audio ? this.audio.sources.filter((source) => !this.audio.muted[source]) : [];

        for (const source of sources.filter((source) => this.audio.muted[source])) {
            if (!live.mute) {
                entry.controller.abort();
                this.warn(`the capture cannot mute ${source}; restarting without it`);
                continue;
            }

            void live.mute(source, true).catch((error: unknown) => {
                entry.controller.abort();
                this.warn(`could not mute ${source}: ${String(error)}`);
            });
        }

        if (this.state === "paused") {
            live.pause();
        }
    }

    /** A capture's frames into the pending list (written now with `flush: "piece"`); false when it kept none. */
    private async onResult(entry: SessionCapture, result: CaptureResult): Promise<boolean> {
        const displayId = entry.startDisplayId;

        try {
            for (const frame of [...result.frames].sort((a, b) => a.atMs - b.atMs)) {
                const item: PendingFrame = {
                    frame,
                    displayId: frame.displayId ?? displayId,
                    atMs: result.startedAtMs + frame.atMs - this.startedAt.getTime(),
                };

                if (this.flush === "piece") {
                    await this.keep(item);
                }

                this.pending.push(item);
            }

            for (const track of result.tracks ?? []) {
                this.tracks.push({ ...track, displayId, startedAtMs: result.startedAtMs });
            }

            this.streamed = 0;
            this.server?.update({ frames: this.pending.length });
            return result.frames.length > 0;
        } catch (error) {
            log.warn({ error, displayId }, "a capture of the library recording failed");
            this.warn(`display ${displayId}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    async status(): Promise<RecorderStatus> {
        return {
            kind: this.kind,
            title: this.options.title ?? this.id,
            state: this.state,
            displays: this.recordedDisplays(),
            frames: this.pending.length + this.streamed,
            warning: this.warnings.at(-1),
            folder: this.folder,
        };
    }

    async pause(): Promise<{ state: RecorderState }> {
        if (this.stopRequested) {
            throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is stopping");
        }

        if (this.state === "paused") {
            throw new RpcError(RPC_ERRORS.alreadyPaused, "the recording is already paused");
        }

        this.state = "paused";
        this.captures.pause();

        this.server?.update({ state: "paused" });
        return { state: "paused" };
    }

    async resume(): Promise<{ state: RecorderState }> {
        if (this.state !== "paused" || this.stopRequested) {
            throw new RpcError(RPC_ERRORS.notPaused, "the recording is not paused");
        }

        this.state = "recording";
        this.captures.resume();

        this.wake?.();
        this.server?.update({ state: "recording" });
        return { state: "recording" };
    }

    async stop(options: { wait?: boolean } = {}): Promise<StopAnswer> {
        if (!this.finishing) {
            this.stopRequested = true;
            this.state = "stopping";
            this.server?.update({ state: "stopping" });
            this.restartCaptures();
            this.wake?.();
            const finish = runRecordingFinish<number>({
                jobs: this.jobs,
                kind: "finalize",
                initial: 0,
                steps: [
                    {
                        name: "captures",
                        run: async () => {
                            await this.loop;
                            return 0;
                        },
                    },
                    { name: "frames", run: (ctx) => this.keepFrames(ctx) },
                    {
                        name: "manifest",
                        run: async (ctx) => {
                            this.writeManifest();
                            return ctx.state;
                        },
                    },
                ],
                answer: (frames, job) => ({
                    state: "stopped",
                    outcome: this.discarded ? "discarded" : "done",
                    job,
                    frames,
                    notes: [...this.warnings],
                }),
                close: () => this.server?.close("stopped"),
            });
            // The stop settles once the socket is closed.
            const done = finish.closed.then(() => finish.answer);
            void done.catch((error: unknown) =>
                log.warn({ error, id: this.id }, "library recording post-processing failed")
            );
            void done.then(this.completion.resolve, this.completion.reject);
            this.finishing = { job: finish.job, done };
        }

        if (options.wait === false) {
            return { state: "stopping", job: this.finishing.job };
        }

        return this.finishing.done;
    }

    override async discard(): Promise<StopAnswer> {
        if (!this.ownsFolder) {
            throw new Error("This recording does not own its folder");
        }

        this.discarded = true;
        const answer = await this.stop();
        const config = loadRmConfig();
        const caller = rmCallerFromRuntime();
        const context = defaultRuleContext(config, caller, process.cwd());
        const plan = planRemoval([this.folder], context);

        if (plan.some((item) => item.verdict.kind === "deny")) {
            throw new Error("The recording folder is protected from removal");
        }

        // Discard authorizes only the folder this recording reserved at its start, so it goes to the trash as a whole.
        moveToTrash(
            plan.map((item) => ({ target: item.target, rule: "recording-discard" })),
            { config, caller, graceMinutes: Math.max(...plan.map((item) => graceMinutesFor(item, context))) }
        );
        this.ownsFolder = false;
        kickDrainer(config);
        return answer;
    }

    private async keepFrames(ctx: {
        progress(event: { done: number; total: number; unit: string }): void;
    }): Promise<number> {
        if (this.discarded) {
            return 0;
        }

        const frames = this.pending.sort((a, b) => a.atMs - b.atMs);
        const audioDir = join(this.folder, "audio");

        for (const [index, item] of frames.entries()) {
            if (!item.kept) {
                await this.keep(item);
            }

            ctx.progress({ done: index + 1, total: frames.length, unit: "frames" });
        }

        for (const track of this.tracks) {
            if (track.path && existsSync(track.path)) {
                mkdirSync(audioDir, { recursive: true });
                const target = join(audioDir, `${track.startedAtMs}-d${track.displayId}-${basename(track.path)}`);
                renameSync(track.path, target);
                track.path = target;
            }
        }

        rmSync(join(this.folder, ".pieces"), { recursive: true, force: true });
        return frames.length;
    }

    /** Writes one frame under `frames/` (name, format, OCR) and points the item at its file. */
    private async keep(item: PendingFrame): Promise<void> {
        const kept = await this.output.keep(item.frame, {
            atMs: this.startedAt.getTime() + item.atMs,
            originMs: this.startedAt.getTime(),
            displayId: item.displayId,
        });
        item.frame = { ...item.frame, path: kept.path };
        item.kept = true;
    }

    private writeManifest(): void {
        if (this.discarded) {
            return;
        }

        const manifest: RecordingManifest = {
            version: 1,
            id: this.id,
            title: this.options.title ?? this.id,
            startedAt: this.startedAt.toISOString(),
            endedAt: new Date().toISOString(),
            displays: this.recordedDisplays(),
            settings: { ...this.settings, audio: this.audio, tracks: this.tracks },
            frames: this.pending.map((item) => ({
                file: join("frames", basename(item.frame.path)),
                atMs: Math.max(0, Math.round(item.atMs)),
                displayId: item.displayId,
                changePercent: item.frame.changePercent,
                reason: item.frame.reason,
            })),
            warnings: [...this.warnings],
        };
        atomicWriteFileSync(join(this.folder, RECORDING_MANIFEST), SafeJSON.stringify(manifest, null, 2));
    }

    override async listDisplays(): Promise<DisplayEntry[]> {
        this.known = await this.options.recorder.displays();
        return this.known.map((display) => ({ ...display, recorded: this.chosen.includes(display.id) }));
    }

    private choose(next: number[]): DisplaySelection {
        this.chosen = next;
        this.server?.update({ displays: this.recordedDisplays() });
        this.restartCaptures();
        return { mode: "all", chosen: next, applied: "restart" };
    }

    override async addDisplay(displayId: number): Promise<DisplaySelection> {
        return this.choose(this.pick([...this.chosen, displayId]));
    }

    override async removeDisplay(displayId: number): Promise<DisplaySelection> {
        const next = this.chosen.filter((id) => id !== displayId);

        if (next.length === 0) {
            throw new RpcError(RPC_ERRORS.lastDisplay, "the recording keeps at least one display");
        }

        return this.choose(next);
    }

    override async switchDisplay(displayId: number): Promise<DisplaySelection> {
        const [to] = this.pick([displayId]);
        const captures = [...this.running.values()];

        if (captures[0]?.live) {
            await captures[0].live.switchDisplay(to);
            for (const other of captures.slice(1)) {
                other.controller.abort();
            }

            this.running.delete(captures[0].target.displayId);
            captures[0].target = this.targetOf(to);
            this.running.set(to, captures[0]);
            this.chosen = [to];
            this.server?.update({ displays: this.recordedDisplays() });
            return { mode: "all", chosen: [to], applied: "live" };
        }

        return this.choose([to]);
    }

    override async setDisplayMode(mode: DisplayMode): Promise<DisplaySelection> {
        return { ...this.choose(this.pick(mode)), mode };
    }

    override async listJobs(): Promise<JobInfo[]> {
        return this.jobs.list();
    }

    override async listAudioDevices(): Promise<AudioDevices> {
        try {
            return await this.options.recorder.audioDevices();
        } catch (error) {
            throw new RpcError(RPC_ERRORS.unsupported, error instanceof Error ? error.message : String(error));
        }
    }

    override async muteAudio(source: AudioSource, muted: boolean): Promise<AudioState> {
        if (!this.audio.sources.includes(source)) {
            throw new RpcError(RPC_ERRORS.unsupported, `this recording records no ${source} sound`);
        }

        if (this.audio.muted[source] === muted) {
            return this.audio;
        }

        // The running captures were started without the muted source: only new captures can add it.
        if (!muted) {
            this.audio = { ...this.audio, muted: { ...this.audio.muted, [source]: false } };
            this.restartCaptures();
            return this.audio;
        }

        const owners = [...this.running.values()].filter((one) => one.audio);

        if (owners.some((one) => !one.live?.mute)) {
            throw new RpcError(RPC_ERRORS.unsupported, `the running capture cannot mute ${source}`);
        }

        await Promise.all(owners.map((one) => one.live?.mute?.(source, true))).catch((error: unknown) => {
            throw new RpcError(RPC_ERRORS.internal, error instanceof Error ? error.message : String(error));
        });
        this.audio = { ...this.audio, muted: { ...this.audio.muted, [source]: true } };
        return this.audio;
    }

    override async setAudioInput(deviceId: string): Promise<AudioState> {
        if (!this.audio.sources.includes("mic")) {
            throw new RpcError(RPC_ERRORS.unsupported, "this recording records no microphone");
        }

        const devices = await this.listAudioDevices();

        if (!devices.inputs.some((device) => device.id === deviceId)) {
            throw new RpcError(RPC_ERRORS.unknownDevice, `no input device ${deviceId}; see audio.list`);
        }

        this.audio = { ...this.audio, micDevice: deviceId };
        const owners = [...this.running.values()].filter((one) => one.audio);

        if (owners.length > 0 && owners.every((one) => one.live?.setMic)) {
            await Promise.all(owners.map((one) => one.live?.setMic?.(deviceId))).catch((error: unknown) => {
                throw new RpcError(RPC_ERRORS.internal, error instanceof Error ? error.message : String(error));
            });
        } else {
            this.restartCaptures();
        }

        return this.audio;
    }

    override async getSettings(): Promise<SettingsAnswer> {
        return { settings: this.settings, audio: this.audio };
    }

    override async setSettings(patch: RecorderSettingsPatch): Promise<SettingsAnswer> {
        const before = this.settings;
        this.settings = { ...before, ...patch, ocr: { ...before.ocr, ...patch.ocr } };
        // Live only when every capture takes every change; otherwise every capture restarts with the new settings.
        const applied = await this.captures.applySettings({
            change: patchChange(patch),
            settings: this.settings,
            scope: "all",
        });
        return { settings: this.settings, audio: this.audio, applied };
    }
}

/** Starts a library recording and returns it once its live socket listens. */
export function startRecording(options: ManagedRecordingOptions): ManagedRecording;
export function startRecording(options: StartRecordingOptions): Promise<LibraryRecording>;
export function startRecording(
    options: StartRecordingOptions | ManagedRecordingOptions
): Promise<LibraryRecording> | ManagedRecording {
    if ("session" in options) {
        return new ManagedRecording(options);
    }

    return new LibraryRecording(options).start();
}
