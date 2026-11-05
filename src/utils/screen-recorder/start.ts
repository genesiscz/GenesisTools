import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
    type RecorderMethod,
    type RecorderSettings,
    type RecorderSettingsPatch,
    type RecorderStatus,
    RPC_ERRORS,
    RpcError,
    type SettingsAnswer,
    type StopAnswer,
} from "./control";
import {
    type FrameNaming,
    FrameOutput,
    type JpegConverter,
    type OcrRecognizer,
    type OcrSinkKind,
    ocrSinkFor,
} from "./frame-output";
import { RECORDING_MANIFEST, type RecordingManifest, recordingsLibraryDir } from "./library";
import { liveRecordingId } from "./live";
import { FrameRecording } from "./recording";
import { patchChange, type SessionCapture } from "./session";
import { displayTarget, type PieceTarget, pickDisplayIds } from "./targets";
import {
    type AudioTrack,
    type CapturedFrame,
    CaptureError,
    type CaptureResult,
    type DisplayInfo,
    type FrameRecorder,
} from "./types";

const { log } = logger.scoped("screen-recorder-start");

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
export class LibraryRecording extends FrameRecording<number> {
    readonly id: string;
    readonly folder: string;
    private settings: RecorderSettings;
    private audio: AudioState;
    private chosen: number[] = [];
    private known: DisplayInfo[] = [];
    private readonly pending: PendingFrame[] = [];
    private readonly tracks: Array<AudioTrack & { displayId: number; startedAtMs: number }> = [];
    private readonly warnings: string[] = [];
    private discarded = false;
    /** The folder was made by this recording's start; only then may discard move it to the trash. */
    private ownsFolder = false;
    private readonly output: FrameOutput;
    private readonly flush: FrameFlush;

    constructor(private readonly options: StartRecordingOptions) {
        // Two recordings started in one second must not share an id, a socket or a folder.
        const id = options.id ?? liveRecordingId("library", `${stamp(new Date())}-${randomUUID()}`);
        const folder = options.folder ?? recordingsLibraryDir(id);
        super({
            kind: "library",
            methods: METHODS,
            recorder: options.recorder,
            // start() checks the recorder's availability; the captures reuse that answer.
            readiness: Promise.resolve(),
            live: {
                id,
                title: options.title ?? id,
                folder,
                dir: options.liveDir,
                displays: () => this.recordedDisplays(),
            },
            pieces: {
                dir: join(folder, ".pieces"),
                sec: options.pieceSec ?? 60,
                maxMs: (options.maxDurationSec ?? 600) * 1000,
                // Every capture records the sound, without the muted sources.
                audioOwnership: "every",
                request: () => ({
                    activeFps: this.settings.activeFps,
                    idleFps: this.settings.idleFps,
                    thresholdPercent: this.settings.threshold,
                    maxLongSidePx: this.settings.maxLongSide,
                    heartbeatSec: this.settings.heartbeatSec || undefined,
                }),
                audio: () => {
                    const sources = this.audio.sources.filter((source) => !this.audio.muted[source]);
                    return sources.length > 0 ? { sources, micDeviceId: this.audio.micDevice } : undefined;
                },
                targets: () =>
                    (options.recorder.supports.parallelCaptures ? this.chosen : this.chosen.slice(0, 1)).map(
                        (displayId) => this.targetOf(displayId)
                    ),
                failures: {
                    max: 3,
                    pauseMs: 0,
                    verdict: ({ outcome, error }) => {
                        if (error !== undefined) {
                            throw error;
                        }

                        return outcome && outcome.frames > 0 ? "recorded" : "failed";
                    },
                    gaveUp: () => this.warn("three captures in a row recorded nothing; the recording ends"),
                },
            },
            whileStopping: "answered",
            hooks: {
                // Anything a piece throws ends the recording; the finish still keeps what it recorded.
                onError: (error) => {
                    log.error({ error, id }, "the library recording stopped on an error");
                    this.warn(
                        `the recording stopped on an error: ${error instanceof Error ? error.message : String(error)}`
                    );
                },
                captures: {
                    onFrame: (entry, frame) => this.onFrame(entry, frame),
                    onResult: (entry, result) => this.onResult(entry, result),
                    onError: (entry, error) => {
                        const displayId = entry.startDisplayId;
                        log.warn({ error, displayId }, "a capture of the library recording failed");

                        if (!(error instanceof CaptureError && error.kind === "display-missing")) {
                            this.warn(
                                `display ${displayId}: ${error instanceof Error ? error.message : String(error)}`
                            );
                        }
                    },
                },
            },
            finish: {
                kind: "finalize",
                initial: 0,
                capturesStep: "captures",
                steps: [
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
                closeReason: () => "stopped",
            },
        });
        this.id = id;
        this.folder = folder;
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
        this.output = new FrameOutput({
            folder,
            naming: frames.naming ?? "elapsed",
            format:
                frames.format === "jpeg" ? { kind: "jpeg", quality: frames.jpegQuality ?? 0.75 } : { kind: "original" },
            convert: options.deps?.convert,
            ocr: {
                settings: () => this.settings.ocr,
                sink: ocrSinkFor(options.ocrSink ?? "sidecar", folder),
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
        this.open();
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
        this.update({ warning: message });
        log.warn({ id: this.id }, message);
    }

    private restartCaptures(): void {
        this.captures.abortAll();
    }

    private targetOf(displayId: number): PieceTarget {
        const display = this.known.find((one) => one.id === displayId);
        return display
            ? displayTarget(display)
            : { target: { kind: "display", displayId }, displayId, label: `display ${displayId}` };
    }

    /** The frames kept so far and those each running capture announced and has not returned yet. */
    private liveFrames(): number {
        return this.pending.length + [...this.running.values()].reduce((sum, one) => sum + one.streamed, 0);
    }

    private onFrame(entry: SessionCapture, frame: CapturedFrame): void {
        const at = new Date().toISOString();
        entry.streamed += 1;
        this.update({ frames: this.liveFrames(), lastFrameAt: at });
        this.emit("frame", { displayId: frame.displayId ?? entry.startDisplayId, at, file: frame.path });
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

            entry.streamed = 0;
            this.update({ frames: this.liveFrames() });
            return result.frames.length > 0;
        } catch (error) {
            log.warn({ error, displayId }, "a capture of the library recording failed");
            this.warn(`display ${displayId}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    override async status(): Promise<RecorderStatus> {
        const entry = this.entry;
        return {
            kind: this.kind,
            title: this.options.title ?? this.id,
            state: this.state,
            displays: this.recordedDisplays(),
            frames: this.liveFrames(),
            ...(entry?.lastFrameAt ? { lastFrameAt: entry.lastFrameAt } : {}),
            warning: this.warnings.at(-1),
            folder: this.folder,
        };
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
        this.update({ displays: this.recordedDisplays() });
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
        const [only, ...others] = [...this.running.values()];

        if (only?.live) {
            try {
                await only.live.switchDisplay(to);
            } catch (error) {
                throw new RpcError(
                    error instanceof CaptureError && error.kind === "display-missing"
                        ? RPC_ERRORS.unknownDisplay
                        : RPC_ERRORS.internal,
                    error instanceof Error ? error.message : String(error)
                );
            }

            // The capture may have ended while the switch was in flight; the next captures record the display.
            if (this.running.get(only.target.displayId) !== only) {
                return this.choose([to]);
            }

            for (const other of others) {
                other.controller.abort();
            }

            this.running.delete(only.target.displayId);
            only.target = this.targetOf(to);
            this.running.set(to, only);
            this.chosen = [to];
            this.update({ displays: this.recordedDisplays() });
            return { mode: "all", chosen: [to], applied: "live" };
        }

        return this.choose([to]);
    }

    override async setDisplayMode(mode: DisplayMode): Promise<DisplaySelection> {
        return { ...this.choose(this.pick(mode)), mode };
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
export function startRecording(options: StartRecordingOptions): Promise<LibraryRecording> {
    return new LibraryRecording(options).start();
}
