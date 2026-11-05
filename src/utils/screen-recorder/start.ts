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
    type AudioSource,
    OCR_READ_DEFAULTS,
    type RecorderMethod,
    type RecorderSettings,
    RPC_ERRORS,
    type StopAnswer,
} from "./control";
import { ChosenDisplays } from "./display-choice";
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
import { emptyPieceVerdict, FRAME_RECORDING_METHODS, FrameRecording } from "./recording";
import { patchChange, type SessionCapture } from "./session";
import { type AudioTrack, type CapturedFrame, CaptureError, type CaptureResult, type FrameRecorder } from "./types";

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

const METHODS: readonly RecorderMethod[] = [...FRAME_RECORDING_METHODS, "discard"];

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
    private readonly choice: ChosenDisplays;
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
        const choice = new ChosenDisplays();
        const sources: AudioSource[] = [
            ...(options.audio?.mic ? (["mic"] as const) : []),
            ...(options.audio?.system ? (["system"] as const) : []),
        ];
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
                displays: () => choice.recorded(),
            },
            settings: {
                activeFps: options.fps ?? 2,
                idleFps: options.idleFps ?? 0.5,
                threshold: options.threshold ?? 1,
                maxLongSide: options.maxLongSide ?? 2560,
                heartbeatSec: options.heartbeatSec ?? 0,
                ocr: { enabled: false, languages: ["en-US"], minChars: 20, ...OCR_READ_DEFAULTS, ...options.ocr },
            },
            audio: { sources, muted: { mic: false, system: false }, micDevice: options.audio?.micDeviceId },
            displays: choice,
            keptFrames: () => this.pending.length,
            pieces: {
                dir: join(folder, ".pieces"),
                sec: options.pieceSec ?? 60,
                maxMs: (options.maxDurationSec ?? 600) * 1000,
                // Every capture records the sound, without the muted sources.
                audioOwnership: "every",
                request: (now) => ({ heartbeatSec: now.heartbeatSec || undefined }),
                failures: {
                    max: 3,
                    pauseMs: 0,
                    verdict: emptyPieceVerdict,
                    gaveUp: () => this.warn("three captures in a row recorded nothing; the recording ends"),
                },
            },
            controls: {
                whileStopping: "answered",
                unrecordedSource: RPC_ERRORS.unsupported,
                // Live only when every capture takes every change; otherwise every capture restarts.
                settings: { scope: "all", change: (_before, _after, patch) => patchChange(patch) },
            },
            // The frames count from the recording's start, so the markers do too (the default origin).
            markers: { save: () => this.writeManifest(false) },
            hooks: {
                // Anything a piece throws ends the recording; the finish still keeps what it recorded.
                onError: (error) => {
                    log.error({ error, id }, "the library recording stopped on an error");
                    this.warn(
                        `the recording stopped on an error: ${error instanceof Error ? error.message : String(error)}`
                    );
                },
                captures: {
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
                            this.writeManifest(true);
                            return ctx.state;
                        },
                    },
                ],
                answer: (frames, job) => {
                    // The finished recording reports and publishes stopped before its socket closes.
                    this.update({ state: "stopped" });
                    return {
                        state: "stopped",
                        outcome: this.discarded ? "discarded" : "done",
                        job,
                        frames,
                        notes: [...this.warnings],
                    };
                },
                closeReason: () => "stopped",
            },
        });
        this.id = id;
        this.folder = folder;
        this.choice = choice;
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

        this.choice.known = await recorder.displays();
        this.options.signal?.throwIfAborted();
        this.choice.chosen = this.choice.pick(this.options.displays ?? "main", recorder);

        if (this.audio.sources.length > 0 && !recorder.supports.audio) {
            this.warn(`the ${recorder.id} recorder records no sound; recording frames only`);
            this.recordNoSound();
        }

        this.startedAt.setTime(Date.now());
        // The folder is reserved exclusively: an existing one (another recording, or a user's folder) is refused.
        mkdirSync(dirname(this.folder), { recursive: true });
        mkdirSync(this.folder);
        this.ownsFolder = true;
        mkdirSync(join(this.folder, "frames"));
        this.open();
        log.info({ id: this.id, displays: this.choice.chosen, recorder: recorder.id }, "library recording started");
        return this;
    }

    private warn(message: string): void {
        this.warnings.push(message);
        this.update({ warning: message });
        log.warn({ id: this.id }, message);
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

            return result.frames.length > 0;
        } catch (error) {
            log.warn({ error, displayId }, "a capture of the library recording failed");
            this.warn(`display ${displayId}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
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
        const batch = moveToTrash(
            plan.map((item) => ({ target: item.target, rule: "recording-discard" })),
            { config, caller, graceMinutes: Math.max(...plan.map((item) => graceMinutesFor(item, context))) }
        );

        // Nothing moved (the trash refused it): the folder and the claim on it stay, and the discard says so.
        if (!batch) {
            throw new Error("The recording folder changed before it could be discarded");
        }

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

    /**
     * Writes recording.json. `final`: every frame, the tracks and the end time. Before that (a marker while it records)
     * only what is in place: the frames already under `frames/` and no end time, so a reader still sees it record.
     */
    private writeManifest(final: boolean): void {
        if (this.discarded) {
            return;
        }

        const frames = final ? this.pending : this.pending.filter((item) => item.kept).sort((a, b) => a.atMs - b.atMs);
        const manifest: RecordingManifest = {
            version: 1,
            id: this.id,
            title: this.options.title ?? this.id,
            startedAt: this.startedAt.toISOString(),
            ...(final ? { endedAt: new Date().toISOString() } : {}),
            displays: this.choice.recorded(),
            settings: {
                ...this.settings,
                audio: this.audio,
                ...(final ? { tracks: this.tracks } : {}),
                ...(this.markers.length > 0 ? { markers: [...this.markers] } : {}),
            },
            frames: frames.map((item) => ({
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
}

/** Starts a library recording and returns it once its live socket listens. */
export function startRecording(options: StartRecordingOptions): Promise<LibraryRecording> {
    return new LibraryRecording(options).start();
}
