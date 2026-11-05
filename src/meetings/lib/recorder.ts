import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
} from "node:fs";
import { join } from "node:path";
import { ensureBinaryAsync } from "@app/control/lib/runner";
import { writeMeetingRecordingManifest } from "@app/meetings/lib/recording-manifest";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import {
    type DisplayPolicy,
    displayPolicySchema,
    languageSettings,
    type MeetingsConfig,
    meetingsConfigSchema,
    recorderSettings,
} from "@genesiscz/utils/meetings/config";
import {
    type MeetingStore,
    RECORDING_STOP_REASONS,
    type RecordingBlock,
    type RecordingStopReason,
    recordingDisplaySpanSchema,
} from "@genesiscz/utils/meetings/record";
import { inspectPidFile } from "@genesiscz/utils/process/pidfile";
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
    RPC_ERRORS,
    RpcError,
    recorderSettingsSchema,
    type SettingsAnswer,
} from "@genesiscz/utils/screen-recorder/control";
import {
    FrameOutput,
    type JpegConverter,
    JsonlOcrSink,
    type OcrRecognizer,
    sipsJpeg,
    visionOcr,
    wallClockFrameName,
} from "@genesiscz/utils/screen-recorder/frame-output";
import { liveRecordingId } from "@genesiscz/utils/screen-recorder/live";
import { FRAME_RECORDERS } from "@genesiscz/utils/screen-recorder/recorders";
import { FrameRecording, type RecorderConfig } from "@genesiscz/utils/screen-recorder/recording";
import { settingsChange } from "@genesiscz/utils/screen-recorder/session";
import { displayTarget, type PieceTarget, pieceTargets } from "@genesiscz/utils/screen-recorder/targets";
import {
    CaptureError,
    type CaptureResult,
    type DisplayInfo,
    type FrameRecorder,
} from "@genesiscz/utils/screen-recorder/types";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { z } from "zod";
import { CallTimeline } from "./call-timeline";
import { collectRecord } from "./collect";
import { claimRecorderPid, RecorderStateFile, RecordingRecord } from "./recorder-adapters";
import { meetingSource, sourceRefOf } from "./sources";
import { RETRY_AFTER_MS, readAuto } from "./watch-auto";

const { log } = logger.scoped("meetings-recorder");

/** One capture runs at most 180 s; shorter pieces also re-read the displays sooner. */
const CHUNK_SEC = 30;
/** Consecutive pieces in which every capture failed, after which the recorder gives up. */
const MAX_FAILURES = 3;
const FAILURE_PAUSE_MS = 5_000;
/** The first frame's OCR finds less text than this: probably only the desktop, so the grant is likely missing. */
const EMPTY_FRAME_CHARS = 20;
/** How long the socket stays open after the stop answer, so the answer reaches the caller. */
const STOP_ANSWER_MS = 50;

/** Where the one running recording keeps its pid and its state. */
export function recorderFiles(store: MeetingStore): { pid: string; state: string } {
    return { pid: join(store.root, "recorder.pid"), state: join(store.root, "recorder.json") };
}

/** The live recording of a meeting's recorder, whose socket `record pause|resume|stop|display` and the menu bar call. */
export function meetingLiveId(meetingId: string): string {
    return liveRecordingId("meeting", meetingId);
}

const recorderStateSchema = z.object({
    meetingId: z.string(),
    pid: z.number(),
    startedAt: z.string(),
    /** The display policy (an index for a recorder from before the policies). */
    display: displayPolicySchema,
    backend: z.string().optional(),
    displays: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
    /** When each display was captured so far, for `meetings screen` while the recording runs. */
    displaySpans: z.array(recordingDisplaySpanSchema).optional(),
    paused: z.boolean().optional(),
    frames: z.number(),
    bytes: z.number(),
    lastFrameAt: z.string().optional(),
    warning: z.string().optional(),
    stopReason: z.enum(RECORDING_STOP_REASONS).optional(),
});
export type RecorderState = z.infer<typeof recorderStateSchema>;

export function readRecorderState(store: MeetingStore): { running: boolean; state?: RecorderState } {
    const files = recorderFiles(store);
    const running = inspectPidFile(files.pid).status === "live";
    const parsed = existsSync(files.state)
        ? recorderStateSchema.safeParse(SafeJSON.parse(readFileSync(files.state, "utf8")))
        : undefined;
    return { running, ...(parsed?.success ? { state: parsed.data } : {}) };
}

/** `15-23-41-502-d4.jpg`: the frame's local wall time, sortable within a day, and its display. */
export function frameName(at: Date, displayId: number): string {
    return wallClockFrameName(at, displayId);
}

/** The frames a recording holds on disk, their size, and the count per display (from the `-d<id>` of the name). */
export function framesOnDisk(framesDir: string): { frames: number; bytes: number; perDisplay: Map<number, number> } {
    const files = readdirSync(framesDir).filter((name) => name.endsWith(".jpg"));
    const perDisplay = new Map<number, number>();

    for (const name of files) {
        const id = name.match(/-d(\d+)\.jpg$/)?.[1];

        if (id) {
            perDisplay.set(Number(id), (perDisplay.get(Number(id)) ?? 0) + 1);
        }
    }

    return {
        frames: files.length,
        bytes: files.reduce((sum, name) => sum + statSync(join(framesDir, name)).size, 0),
        perDisplay,
    };
}

/** The displays of a piece: moved to the shared capture session (`@genesiscz/utils/screen-recorder/targets`). */
export { pieceTargets };

const METHODS: readonly RecorderMethod[] = [
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
];

/** The meetings recorder's own calls on top of the shared run; the closures of one `runRecorder` call. */
interface MeetingControlOps {
    listDisplays(): Promise<DisplayEntry[]>;
    addDisplay(displayId: number): Promise<DisplaySelection>;
    removeDisplay(displayId: number): Promise<DisplaySelection>;
    switchDisplay(displayId: number): Promise<DisplaySelection>;
    setDisplayMode(mode: DisplayMode): Promise<DisplaySelection>;
    getSettings(): Promise<SettingsAnswer>;
    setSettings(patch: RecorderSettingsPatch): Promise<SettingsAnswer>;
    listAudioDevices(): Promise<AudioDevices>;
    muteAudio(source: AudioSource, muted: boolean): Promise<AudioState>;
    setAudioInput(deviceId: string): Promise<AudioState>;
}

/** The meetings recorder: the shared run, displays by id, no discard, restart or target switch. */
class MeetingRecording extends FrameRecording<string[]> {
    constructor(
        config: RecorderConfig<string[]>,
        private readonly ops: MeetingControlOps
    ) {
        super(config);
    }

    override listDisplays(): Promise<DisplayEntry[]> {
        return this.ops.listDisplays();
    }

    override addDisplay(displayId: number): Promise<DisplaySelection> {
        return this.ops.addDisplay(displayId);
    }

    override removeDisplay(displayId: number): Promise<DisplaySelection> {
        return this.ops.removeDisplay(displayId);
    }

    override switchDisplay(displayId: number): Promise<DisplaySelection> {
        return this.ops.switchDisplay(displayId);
    }

    override setDisplayMode(mode: DisplayMode): Promise<DisplaySelection> {
        return this.ops.setDisplayMode(mode);
    }

    override getSettings(): Promise<SettingsAnswer> {
        return this.ops.getSettings();
    }

    override setSettings(patch: RecorderSettingsPatch): Promise<SettingsAnswer> {
        return this.ops.setSettings(patch);
    }

    override listAudioDevices(): Promise<AudioDevices> {
        return this.ops.listAudioDevices();
    }

    override muteAudio(source: AudioSource, muted: boolean): Promise<AudioState> {
        return this.ops.muteAudio(source, muted);
    }

    override setAudioInput(deviceId: string): Promise<AudioState> {
        return this.ops.setAudioInput(deviceId);
    }
}

export interface RecorderNote {
    title: string;
    message: string;
    open?: string;
}

/** What the recorder uses beside the store, so a test can replace each part. */
export interface RecorderDeps {
    recorder: FrameRecorder;
    toJpeg: JpegConverter;
    ocr: OcrRecognizer;
    notify: (note: RecorderNote) => Promise<void>;
    /** Where the live recording entry goes (the genesis-tools root's `recordings/live/` by default). */
    liveDir?: string;
    pieceSec: number;
    failurePauseMs: number;
}

function defaultOcrLanguages(): string[] {
    return languageSettings(meetingsConfigSchema.parse({})).ocr;
}

function defaultDeps(capture: MeetingsConfig["global"]["capture"]): RecorderDeps {
    return {
        recorder: FRAME_RECORDERS[capture.backend]({ axTool: async (options) => [await ensureBinaryAsync(options)] }),
        toJpeg: sipsJpeg,
        ocr: visionOcr,
        notify: async (note) => {
            await sendNotification({ ...note, group: "meetings" }).catch((err: unknown) =>
                log.warn({ err }, "notification failed")
            );
        },
        pieceSec: CHUNK_SEC,
        failurePauseMs: FAILURE_PAUSE_MS,
    };
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * The recorder process (`tools meetings record run`): captures the screen in pieces until a stop (a live recording
 * command, `record stop`, or a signal), converts each new frame to JPEG under the meeting's `frames/`, runs Vision
 * OCR on it into `ocr.jsonl`, and keeps the meeting's `recording` block. Pause and resume end and start a span.
 */
export async function runRecorder(options: {
    store: MeetingStore;
    meetingId: string;
    capture: MeetingsConfig["global"]["capture"];
    /** The Vision OCR languages of the meeting language (`languages.<code>.ocr`); the default language's when omitted. */
    ocrLanguages?: string[];
    /** Overrides `capture.displays`. */
    display?: DisplayPolicy;
    /** Overrides `capture.recorders.<backend>.audio.sources`. */
    audio?: AudioSource[];
    deps?: Partial<RecorderDeps>;
}): Promise<RecorderState> {
    const { store, meetingId, capture } = options;
    const deps: RecorderDeps = { ...defaultDeps(capture), ...options.deps };
    const { audio: audioConfig, ...nativeKeys } = recorderSettings(capture, deps.recorder.id);
    /** What the captures and the OCR use now; `settings.set` changes it while the recording runs. */
    let settings: RecorderSettings = {
        activeFps: capture.activeFps,
        idleFps: capture.idleFps,
        threshold: capture.threshold * 100,
        maxLongSide: capture.resolutionCap,
        heartbeatSec: nativeKeys.heartbeatSec ?? 0,
        ocr: { enabled: true, languages: options.ocrLanguages ?? defaultOcrLanguages(), minChars: 0 },
    };
    const audio: AudioState = {
        sources: options.audio ?? audioConfig?.sources ?? [],
        muted: { mic: false, system: false },
        ...(audioConfig?.micDevice ? { micDevice: audioConfig.micDevice } : {}),
    };
    let policy = options.display ?? capture.displays;
    let chosen: number[] | undefined;
    const files = recorderFiles(store);
    const folder = store.folder(meetingId);
    const framesDir = join(folder, "frames");
    const pieceDir = join(folder, ".piece");
    const ocrPath = join(folder, "ocr.jsonl");
    const audioDir = join(folder, "audio");
    let audioFiles = 0;
    const record = store.read(meetingId);

    const claim = await claimRecorderPid(files.pid);
    const stateFile = new RecorderStateFile<RecorderState>({
        state: files.state,
        last: join(folder, "recorder-last.json"),
    });

    try {
        mkdirSync(framesDir, { recursive: true });
        const state: RecorderState = {
            meetingId,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            display: policy,
            backend: deps.recorder.id,
            frames: 0,
            bytes: 0,
        };
        const notes: string[] = [];
        const note = (text: string) => {
            if (!notes.includes(text)) {
                notes.push(text);
            }
        };
        const recordingRecord = new RecordingRecord(store, meetingId, record?.recording?.spans ?? []);
        const spans = recordingRecord.spans;
        let failureNoticeOpen = Boolean(record?.recording?.failureNotifiedAt);
        let runFrames = 0;
        let lastConnected = "";
        const saveState = () => stateFile.save(state);
        const onSignal = () => recording.requestStop();
        const running = () => recording.captures.running;
        const connected = async (displayId: number): Promise<DisplayInfo> => {
            const display = (await deps.recorder.displays()).find((one) => one.id === displayId);

            if (!display) {
                throw new RpcError(RPC_ERRORS.unknownDisplay, `display ${displayId} is not connected`);
            }

            return display;
        };
        const refuseWhenStopping = () => {
            if (recording.stopping) {
                throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is stopping");
            }
        };
        const answer = (how: "live" | "started" | "stopped" | "restart" | "next-piece") => ({
            mode: policy,
            chosen: chosen ?? null,
            applied: how,
        });
        /** A change no running capture can take: the running piece ends and the next starts with the new set at once. */
        const restart = (change: () => void) => {
            refuseWhenStopping();
            change();
            log.info({ policy, chosen }, "recorded displays chosen over the socket; the piece restarts");
            recording.captures.abortAll();
            return answer("restart");
        };
        const currentIds = () => chosen ?? state.displays?.map((one) => one.id) ?? [];
        const closeSpan = (stopReason: RecordingStopReason, at?: string) => recordingRecord.closeSpan(stopReason, at);
        const targetOf = displayTarget;
        const liveFrames = () => state.frames + [...running().values()].reduce((sum, one) => sum + one.streamed, 0);
        /** Moves a capture's `.m4a` files to the meeting's `audio/` and lists each in `audio.jsonl`. */
        const keepTracks = (result: CaptureResult, target: PieceTarget): void => {
            for (const track of result.tracks ?? []) {
                if (!track.path || !existsSync(track.path)) {
                    continue;
                }

                const at = new Date(result.startedAtMs);
                const name = frameName(at, target.displayId).replace(/\.jpg$/, `-${track.source}.m4a`);
                mkdirSync(audioDir, { recursive: true });
                renameSync(track.path, join(audioDir, name));
                appendFileSync(
                    join(folder, "audio.jsonl"),
                    `${SafeJSON.stringify({ file: `audio/${name}`, source: track.source, at: at.toISOString(), durationMs: track.durationMs, mutedSpans: track.mutedSpans })}\n`
                );
                audioFiles += 1;
            }
        };

        const output = new FrameOutput({
            folder,
            naming: "wall-clock",
            format: { kind: "jpeg", quality: capture.jpegQuality },
            convert: deps.toJpeg,
            ocr: {
                settings: () => settings.ocr,
                sink: new JsonlOcrSink(ocrPath),
                recognize: deps.ocr,
                onError: (err, jpg) => log.warn({ err, jpg }, "OCR failed for a frame"),
            },
        });

        /** `streamed`: the socket announced these frames as they landed already. */
        const keepFrames = async ({
            result,
            target,
            streamed,
            onFrame = () => undefined,
        }: {
            result: CaptureResult;
            target: PieceTarget;
            streamed: boolean;
            onFrame?: (done: number) => void;
        }): Promise<void> => {
            let done = 0;

            for (const frame of [...result.frames].sort((a, b) => a.atMs - b.atMs)) {
                const kept = await output.keep(frame, {
                    atMs: result.startedAtMs + frame.atMs,
                    originMs: Date.parse(state.startedAt),
                    displayId: frame.displayId ?? target.displayId,
                });

                if (kept.read && state.frames === 0 && kept.read.text.trim().length < EMPTY_FRAME_CHARS) {
                    note(
                        `The first frame holds almost no readable text: Screen Recording may be missing (macOS then returns only the desktop; check ${toolCommand("control", "doctor")}), or the text is too small for capture.resolutionCap.`
                    );
                }

                state.frames += 1;
                runFrames += 1;
                state.bytes += kept.bytes;
                state.lastFrameAt = kept.at.toISOString();

                if (!streamed) {
                    recording.emit("frame", { displayId: kept.displayId, at: kept.at.toISOString(), file: kept.path });
                }

                done += 1;
                onFrame(done);
            }
        };

        /** The displays of the next piece: every target at once. */
        const pieceTargetsNow = async (): Promise<PieceTarget[]> => {
            const displays = await deps.recorder.displays();
            const { targets, fallback } = pieceTargets({
                policy,
                displays,
                followFocus: deps.recorder.supports.followFocus,
                chosen,
                parallel: deps.recorder.supports.parallelCaptures,
            });
            const connectedIds = displays.map((display) => display.id).join(",");

            if (connectedIds !== lastConnected) {
                const before = new Set(lastConnected.split(",").filter(Boolean).map(Number));
                const now = new Set(displays.map((display) => display.id));
                recording.emit("displays", {
                    connected: displays.map((display) => ({ id: display.id, name: display.name })),
                    removed: [...before].filter((id) => !now.has(id)),
                });
                lastConnected = connectedIds;
            }

            if (fallback) {
                note(`${fallback} (since ${localTime(new Date().toISOString())})`);
            }

            recording.displayBook.see(displays);

            if (targets.length === 0) {
                throw new CaptureError("display-missing", "no display is connected");
            }

            return targets;
        };

        const ops: MeetingControlOps = {
            getSettings: async () => ({ settings, audio: { ...audio, muted: { ...audio.muted } } }),
            setSettings: async (patch) => {
                refuseWhenStopping();
                const before = settings;
                settings = recorderSettingsSchema.parse({
                    ...settings,
                    ...patch,
                    ocr: { ...settings.ocr, ...patch.ocr },
                });
                // Each capture takes the change live or restarts on its own; ax-tool has no live heartbeat
                // command, so a change of it restarts the capture. No capture running: the next piece takes it.
                const applied = await recording.captures.applySettings({
                    change: settingsChange(before, settings),
                    settings,
                    scope: "each",
                });
                log.info({ settings, applied }, "recorder settings changed over the socket");
                return { settings, audio, applied };
            },
            listAudioDevices: async () => {
                try {
                    return await deps.recorder.audioDevices();
                } catch (error) {
                    throw new RpcError(RPC_ERRORS.unsupported, errorText(error));
                }
            },
            muteAudio: async (source, muted) => {
                refuseWhenStopping();

                if (!audio.sources.includes(source)) {
                    throw new RpcError(RPC_ERRORS.invalidParams, `this recording records no ${source} sound`);
                }

                if (audio.muted[source] === muted) {
                    return { ...audio, muted: { ...audio.muted } };
                }

                // The running captures were started without the muted source: only new captures can add it.
                if (!muted) {
                    restart(() => {
                        audio.muted[source] = false;
                    });
                    log.info({ source }, "audio unmuted over the socket; the piece restarts");
                    return { ...audio, muted: { ...audio.muted } };
                }

                const owners = [...running().values()].filter((one) => one.audio);

                if (owners.some((one) => !one.live?.mute)) {
                    throw new RpcError(RPC_ERRORS.unsupported, `the running capture cannot mute ${source}`);
                }

                await Promise.all(owners.map((one) => one.live?.mute?.(source, true))).catch((error: unknown) => {
                    throw new RpcError(RPC_ERRORS.internal, errorText(error));
                });
                audio.muted[source] = true;
                log.info({ source, muted }, "audio muted over the socket");
                return { ...audio, muted: { ...audio.muted } };
            },
            setAudioInput: async (deviceId) => {
                refuseWhenStopping();

                if (!audio.sources.includes("mic")) {
                    throw new RpcError(RPC_ERRORS.invalidParams, "this recording records no microphone");
                }

                const devices = await deps.recorder.audioDevices().catch((error: unknown) => {
                    throw new RpcError(RPC_ERRORS.unsupported, errorText(error));
                });

                if (!devices.inputs.some((device) => device.id === deviceId)) {
                    throw new RpcError(RPC_ERRORS.unknownDevice, `no input device ${deviceId}; see audio.list`);
                }

                audio.micDevice = deviceId;
                const capture = [...running().values()].find((one) => one.audio);

                if (capture?.live?.setMic) {
                    await capture.live.setMic(deviceId).catch((error: unknown) => {
                        throw new RpcError(RPC_ERRORS.internal, errorText(error));
                    });
                } else {
                    // Every capture restarts, so the one that takes the sound again uses the new microphone.
                    restart(() => undefined);
                }

                return { ...audio, muted: { ...audio.muted } };
            },
            listDisplays: async () => {
                const recordedIds = new Set(state.displays?.map((display) => display.id) ?? []);
                return (await deps.recorder.displays()).map((display) => ({
                    ...display,
                    recorded: recordedIds.has(display.id),
                }));
            },
            addDisplay: async (displayId) => {
                const display = await connected(displayId);
                refuseWhenStopping();

                if (!deps.recorder.supports.parallelCaptures) {
                    throw new RpcError(
                        RPC_ERRORS.invalidParams,
                        `the ${deps.recorder.id} recorder records one display at a time; use displays.switch`
                    );
                }

                chosen = [...new Set([...currentIds(), display.id])];

                if (!recording.captures.inPiece || recording.paused || running().has(display.id)) {
                    return answer("next-piece");
                }

                recording.captures.start(targetOf(display));
                return answer("started");
            },
            removeDisplay: async (displayId) => {
                const current = currentIds();

                if (!current.includes(displayId)) {
                    throw new RpcError(RPC_ERRORS.unknownDisplay, `display ${displayId} is not being recorded`);
                }

                if (current.length === 1) {
                    throw new RpcError(
                        RPC_ERRORS.lastDisplay,
                        "the last recorded display cannot be removed; pause or stop instead"
                    );
                }

                refuseWhenStopping();
                chosen = current.filter((id) => id !== displayId);
                const capture = running().get(displayId);

                if (!capture) {
                    return answer("next-piece");
                }

                if (capture.audio) {
                    return restart(() => undefined);
                }

                capture.controller.abort();
                return answer("stopped");
            },
            switchDisplay: async (displayId) => {
                const display = await connected(displayId);
                refuseWhenStopping();
                const [only, ...others] = [...running().values()];

                if (only?.live && only.target.target.kind === "display") {
                    try {
                        await only.live.switchDisplay(display.id);
                    } catch (error) {
                        throw new RpcError(
                            error instanceof CaptureError && error.kind === "display-missing"
                                ? RPC_ERRORS.unknownDisplay
                                : RPC_ERRORS.internal,
                            errorText(error)
                        );
                    }

                    // The capture may have ended while the switch was in flight; the next piece records it.
                    if (running().get(only.target.displayId) !== only) {
                        chosen = [display.id];
                        return answer("next-piece");
                    }

                    for (const other of others) {
                        other.controller.abort();
                    }

                    running().delete(only.target.displayId);
                    only.target = targetOf(display);
                    recording.openDisplay(only, display.id);
                    running().set(display.id, only);
                    chosen = [display.id];
                    recording.syncDisplays();
                    return answer("live");
                }

                return restart(() => {
                    chosen = [display.id];
                });
            },
            setDisplayMode: async (mode) =>
                restart(() => {
                    policy = mode;
                    chosen = undefined;
                    state.display = policy;
                }),
        };

        const recording: MeetingRecording = new MeetingRecording(
            {
                kind: "meeting",
                methods: METHODS,
                recorder: deps.recorder,
                live: { id: meetingLiveId(meetingId), title: record?.title || meetingId, folder, dir: deps.liveDir },
                history: {
                    intervals: record?.recording?.displaySpans ?? [],
                    names: (record?.recording?.displays ?? []).map((display) => [display.id, display.name]),
                },
                pieces: {
                    dir: pieceDir,
                    sec: deps.pieceSec,
                    audioOwnership: "single",
                    request: () => ({
                        activeFps: settings.activeFps,
                        idleFps: settings.idleFps,
                        thresholdPercent: settings.threshold,
                        maxLongSidePx: settings.maxLongSide,
                        ...nativeKeys,
                        heartbeatSec: settings.heartbeatSec,
                    }),
                    // One capture records the sound: two would write the same microphone twice. A muted source is left
                    // out of a new capture, so its start-up buffers never reach the file; unmuting restarts the capture.
                    audio: () => {
                        const sources = audio.sources.filter((source) => !audio.muted[source]);
                        return deps.recorder.supports.audio && sources.length > 0
                            ? { sources, ...(audio.micDevice ? { micDeviceId: audio.micDevice } : {}) }
                            : undefined;
                    },
                    targets: pieceTargetsNow,
                    failures: {
                        max: MAX_FAILURES,
                        pauseMs: deps.failurePauseMs,
                        // Only a capture fails a piece; anything else (a frame that cannot be converted) ends the
                        // recording.
                        verdict: ({ outcome, error }, now) => {
                            const failure =
                                error ??
                                (outcome && !outcome.recorded && !now.paused && !now.stopping
                                    ? outcome.lastError
                                    : undefined);

                            if (failure === undefined) {
                                return outcome?.recorded ? "recorded" : "neither";
                            }

                            if (failure instanceof CaptureError) {
                                return "failed";
                            }

                            throw failure;
                        },
                        gaveUp: (count, err) => {
                            note(`capture failed ${count} times in a row: ${errorText(err)}`);
                            state.stopReason = "failed";
                        },
                        recorded: async () => {
                            if (failureNoticeOpen) {
                                failureNoticeOpen = false;
                                await recordingRecord.update("capture works again", (recordingBlock) => {
                                    delete recordingBlock.failureNotifiedAt;
                                });
                            }
                        },
                    },
                },
                whileStopping: "refused",
                hooks: {
                    beforeLoop: async () => {
                        process.on("SIGTERM", onSignal);
                        process.on("SIGINT", onSignal);
                        rmSync(pieceDir, { recursive: true, force: true });
                        mkdirSync(pieceDir, { recursive: true });
                        saveState();
                        recordingRecord.openSpan();
                        await recordingRecord.start({
                            startedAt: state.startedAt,
                            backend: deps.recorder.id,
                            displayPolicy: policy,
                            displaySpans: recording.displayBook.intervals,
                        });
                    },
                    afterLoop: () => {
                        process.off("SIGTERM", onSignal);
                        process.off("SIGINT", onSignal);
                        rmSync(pieceDir, { recursive: true, force: true });
                    },
                    onError: (err) => {
                        log.error({ err, meetingId }, "the recorder stopped on an error");
                        note(`the recorder stopped on an error: ${errorText(err)}`);
                        state.stopReason = "error";
                    },
                    onPaused: (at) => {
                        closeSpan("paused", at);
                        state.paused = true;
                        saveState();
                        recordingRecord.markStatus("paused");
                    },
                    onResumed: () => {
                        recordingRecord.openSpan();
                        state.paused = false;
                        saveState();
                        recordingRecord.markStatus("recording");
                    },
                    onDisplays: () => {
                        state.displays = recording.displayBook.recorded;
                        saveState();
                    },
                    afterPiece: () => {
                        state.warning = notes.length > 0 ? notes.join("; ") : undefined;
                        recording.update({
                            frames: liveFrames(),
                            lastFrameAt: state.lastFrameAt,
                            warning: state.warning,
                        });
                        saveState();
                    },
                    captures: {
                        onFrame: (entry, frame) => {
                            entry.streamed += 1;
                            recording.update({ frames: liveFrames(), lastFrameAt: new Date().toISOString() });
                            recording.emit("frame", {
                                displayId: frame.displayId ?? entry.target.displayId,
                                at: new Date().toISOString(),
                                file: frame.path,
                            });
                        },
                        onResult: async (entry, result) => {
                            keepTracks(result, entry.target);
                            await recording.jobs.task("ocr", (ctx) =>
                                keepFrames({
                                    result,
                                    target: entry.target,
                                    streamed: entry.streamed > 0,
                                    onFrame: (done) =>
                                        ctx.progress({ done, total: result.frames.length, unit: "frames" }),
                                })
                            ).done;
                            entry.streamed = 0;

                            if (result.endedEarly === "display-removed") {
                                log.info({ display: entry.target.label }, "a display left during a piece");
                            }

                            return undefined;
                        },
                        onError: (entry, err, outcome) => {
                            if (err instanceof CaptureError && err.kind === "display-missing") {
                                log.info({ display: entry.target.label }, "a display left before its capture");
                                return;
                            }

                            log.warn({ err, display: entry.target.label }, "a capture failed");

                            if (outcome.count > 1) {
                                note(`${entry.target.label}: ${errorText(err)}`);
                            }
                        },
                        onSettled: (entry) => rmSync(entry.outDir, { recursive: true, force: true }),
                    },
                },
                finish: {
                    kind: "finish",
                    id: `finish-${meetingId}-${Date.now()}`,
                    initial: [],
                    steps: [
                        {
                            name: "summary",
                            run: async (ctx) => {
                                await finishRecording();
                                ctx.progress({ done: 1, total: 1, unit: "steps", message: `${state.frames} frames` });
                                return ctx.state;
                            },
                        },
                        {
                            name: "manifest",
                            run: async (ctx) => {
                                const current = store.read(meetingId);

                                if (current) {
                                    writeMeetingRecordingManifest(folder, current);
                                }

                                return ctx.state;
                            },
                        },
                        {
                            name: "collect",
                            run: async () => {
                                const current = store.read(meetingId);
                                return current
                                    ? (await collectRecord(store, current)).notes.map((one) => one.text)
                                    : [];
                            },
                        },
                    ],
                    answer: (finishNotes, job) => ({
                        state: "stopped",
                        outcome: state.stopReason,
                        job,
                        frames: state.frames,
                        notes: finishNotes,
                    }),
                    failed: (err, job) => {
                        log.error({ err, meetingId }, "the recording summary could not be written");
                        return { state: "stopped", outcome: state.stopReason, job, frames: state.frames };
                    },
                    closeReason: () => state.stopReason,
                    // A waiting `stop` call gets its answer before the socket closes.
                    closeAfterMs: STOP_ANSWER_MS,
                },
            },
            ops
        );
        state.displaySpans = recording.displayBook.intervals;
        recording.open();
        await recording.finished;
        stateFile.retire();

        log.info(
            { meetingId, frames: state.frames, bytes: state.bytes, stopReason: state.stopReason },
            "recording stopped"
        );
        return state;

        async function finishRecording(): Promise<void> {
            state.stopReason ??= "requested";

            if (runFrames === 0) {
                note(
                    `No frame was recorded${state.stopReason === "requested" ? " before the stop" : ""}. Check the recorder: ${toolCommand("control", "doctor")}`
                );
            }

            state.warning = notes.length > 0 ? notes.join("; ") : undefined;
            closeSpan(state.stopReason);
            saveState();
            const stoppedAt = new Date().toISOString();
            const total = existsSync(framesDir)
                ? framesOnDisk(framesDir)
                : { frames: 0, bytes: 0, perDisplay: new Map() };
            const current = store.read(meetingId);
            const ref = current ? sourceRefOf(current) : undefined;
            const sourceClock = ref
                ? await (async () =>
                      CallTimeline.sourceClock({
                          source: await meetingSource(ref.sourceId),
                          sourceMeetingId: ref.sourceMeetingId,
                      }))().catch((err: unknown) => {
                      log.warn({ err, meetingId }, "source clock unavailable; finalizing without it");
                      return undefined;
                  })
                : undefined;
            const clock = sourceClock?.source
                ? { source: sourceClock.source, startedAt: sourceClock.startedAt }
                : undefined;

            const failed = state.stopReason === "failed" || state.stopReason === "error";
            const notifyFailure = failed && !current?.recording?.failureNotifiedAt;
            await store.update(
                meetingId,
                {
                    command: "record stop",
                    change: `${state.frames} frames, ${Math.round(state.bytes / 1_000_000)} MB${total.frames > state.frames ? ` (${total.frames} frames, ${Math.round(total.bytes / 1_000_000)} MB in all)` : ""}, ${state.stopReason}${state.warning && failed ? `, ${state.warning}` : ""}`,
                },
                (next) => {
                    const recordingBlock: RecordingBlock = {
                        ...next.recording,
                        startedAt: state.startedAt,
                        stoppedAt,
                        frames: total.frames,
                        bytes: total.bytes,
                        status: "stopped",
                        stopReason: state.stopReason,
                        displayPolicy: policy,
                        ...(audio.sources.length > 0 ? { audio: { sources: audio.sources, files: audioFiles } } : {}),
                        spans,
                        displaySpans: recording.displayBook.intervals,
                        displays: [...recording.displayBook.names].map(([id, name]) => ({
                            id,
                            name,
                            frames: total.perDisplay.get(id) ?? 0,
                        })),
                        ...(clock ? { clock } : {}),
                        ...(notifyFailure ? { failureNotifiedAt: stoppedAt } : {}),
                    };

                    if (state.warning) {
                        recordingBlock.warning = state.warning;
                    } else {
                        delete recordingBlock.warning;
                    }

                    next.recording = recordingBlock;
                }
            );

            if (notifyFailure) {
                const byWatcher = readAuto(store)?.meetingId === meetingId;
                await deps.notify({
                    title: "Screen recording stopped",
                    message: `${state.warning ?? "The capture failed."} ${byWatcher ? `It starts again every ${RETRY_AFTER_MS / 60_000} min while the meeting runs.` : `Start it again: ${toolCommand("meetings", "record", "start", "--meeting", meetingId)}`}`,
                    open: folder,
                });
            }
        }
    } catch (err) {
        // A failure outside the capture loop (the folders, the socket, the session) still leaves a terminal record
        // before the pidfile is released, so `record status` and the watcher never read a recording that is gone.
        const warning = errorText(err);
        const last = readRecorderState(store).state;
        await store
            .update(meetingId, { command: "record stop", change: `error: ${warning}` }, (current) => {
                current.recording = {
                    ...current.recording,
                    status: "stopped",
                    stopReason: "error",
                    stoppedAt: new Date().toISOString(),
                    frames: last?.frames ?? current.recording?.frames ?? 0,
                    bytes: last?.bytes ?? current.recording?.bytes ?? 0,
                    warning,
                };
            })
            .catch((persistErr: unknown) =>
                log.warn({ err: persistErr, meetingId }, "the failed recording could not be saved")
            );
        stateFile.retire();
        throw err;
    } finally {
        claim.release();
    }
}

/** The live displays of a recorder state, for `record status`. */
export function stateDisplays(state: RecorderState): string {
    return state.displays?.length
        ? state.displays.map((display) => `${display.name} (${display.id})`).join(", ")
        : String(state.display);
}
