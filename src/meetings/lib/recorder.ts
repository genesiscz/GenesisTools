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
import { abortableSleep } from "@genesiscz/utils/async";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type JobInfo, JobRegistry } from "@genesiscz/utils/jobs";
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
    type RecordingSpan,
    type RecordingStopReason,
} from "@genesiscz/utils/meetings/record";
import {
    attemptStaleTakeover,
    classifyPidRecord,
    clearPidFile,
    inspectPidFile,
    parsePidRecord,
    writePidFile,
} from "@genesiscz/utils/process/pidfile";
import {
    type AudioDevices,
    type AudioSource,
    type AudioState,
    type RecorderState as ControlState,
    type DisplayEntry,
    type DisplayMode,
    type DisplaySelection,
    RecorderControl,
    type RecorderMethod,
    type RecorderSettings,
    type RecorderSettingsPatch,
    type RecorderStatus,
    RPC_ERRORS,
    RpcError,
    recorderSettingsSchema,
    type SettingsAnswer,
    type StopAnswer,
} from "@genesiscz/utils/screen-recorder/control";
import { mainDisplay } from "@genesiscz/utils/screen-recorder/displays";
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
import { startRecording } from "@genesiscz/utils/screen-recorder/start";
import {
    CaptureError,
    type CaptureHooks,
    type CaptureResult,
    type CaptureTarget,
    type DisplayInfo,
    type FrameRecorder,
    type LiveCapture,
} from "@genesiscz/utils/screen-recorder/types";
import { atomicWriteFileSync, readFileIfExistsSync } from "@genesiscz/utils/storage/atomic-file";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { z } from "zod";
import { CallTimeline } from "./call-timeline";
import { collectRecord } from "./collect";
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

/** A capture that runs this piece: what it records, and the display its frames belong to when the frame says none. */
interface PieceTarget {
    target: CaptureTarget;
    displayId: number;
    label: string;
}

/**
 * What to record right now: the displays chosen over the socket (`displays.add|remove|switch`) when there are any,
 * else the policy. `fallback` says why the main display stands in for the asked one.
 */
export function pieceTargets(options: {
    policy: DisplayPolicy;
    displays: DisplayInfo[];
    followFocus: boolean;
    chosen?: number[];
    /** False: the recorder records one display at a time, so only the first (the main one when it is asked) stays. */
    parallel?: boolean;
}): {
    targets: PieceTarget[];
    fallback?: string;
} {
    const picked = pickTargets(options);

    if (options.parallel !== false || picked.targets.length <= 1) {
        return picked;
    }

    const main = picked.targets.find((target) => target.displayId === mainDisplay(options.displays)?.id);
    return {
        targets: [main ?? picked.targets[0]!],
        fallback: "this recorder records one display at a time; only one display was recorded",
    };
}

function pickTargets(options: {
    policy: DisplayPolicy;
    displays: DisplayInfo[];
    followFocus: boolean;
    chosen?: number[];
}): {
    targets: PieceTarget[];
    fallback?: string;
} {
    const { policy, displays } = options;
    const main = mainDisplay(displays);
    const one = (display: DisplayInfo): PieceTarget => ({
        target: { kind: "display", displayId: display.id },
        displayId: display.id,
        label: `${display.name} (${display.id})`,
    });

    if (!main) {
        return { targets: [] };
    }

    if (options.chosen) {
        const chosen = displays.filter((display) => options.chosen?.includes(display.id));
        return chosen.length > 0
            ? { targets: chosen.map(one) }
            : {
                  targets: [one(main)],
                  fallback: `displays ${options.chosen.join(", ")} were not connected; the main display was recorded while they were missing`,
              };
    }

    if (policy === "all") {
        return { targets: displays.map(one) };
    }

    if (policy === "main") {
        return { targets: [one(main)] };
    }

    if (policy === "follow-focus") {
        return options.followFocus
            ? { targets: [{ target: { kind: "follow-focus" }, displayId: main.id, label: "the focused display" }] }
            : {
                  targets: [one(main)],
                  fallback: "this recorder cannot follow the focused display; the main display was recorded",
              };
    }

    const asked = displays.find((display) => display.index === policy);
    return asked
        ? { targets: [one(asked)] }
        : {
              targets: [one(main)],
              fallback: `display ${policy} was not connected; the main display was recorded while it was missing`,
          };
}

interface RunningCapture {
    target: PieceTarget;
    controller: AbortController;
    /** Commands to the running capture without a restart, when the recorder offers them. */
    live?: LiveCapture;
    /** Frames that landed and were counted live, not converted yet. */
    streamed: number;
    /** This capture records the sound of the recording. */
    audio: boolean;
    done: Promise<void>;
}

/** What the meetings recorder does for each RecorderControl method; the closures of one `runRecorder` call. */
interface MeetingControlOps {
    status(): Promise<RecorderStatus>;
    pause(): Promise<{ state: ControlState }>;
    resume(): Promise<{ state: ControlState }>;
    stop(options: { wait?: boolean }): Promise<StopAnswer>;
    listDisplays(): Promise<DisplayEntry[]>;
    addDisplay(displayId: number): Promise<DisplaySelection>;
    removeDisplay(displayId: number): Promise<DisplaySelection>;
    switchDisplay(displayId: number): Promise<DisplaySelection>;
    setDisplayMode(mode: DisplayMode): Promise<DisplaySelection>;
    listJobs(): Promise<JobInfo[]>;
    getSettings(): Promise<SettingsAnswer>;
    setSettings(patch: RecorderSettingsPatch): Promise<SettingsAnswer>;
    listAudioDevices(): Promise<AudioDevices>;
    muteAudio(source: AudioSource, muted: boolean): Promise<AudioState>;
    setAudioInput(deviceId: string): Promise<AudioState>;
}

/** The meetings recorder as a RecorderControl: displays by id, no discard, restart or target switch. */
class MeetingRecorderControl extends RecorderControl {
    readonly kind = "meeting";
    readonly methods: readonly RecorderMethod[] = [
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

    constructor(private readonly ops: MeetingControlOps) {
        super();
    }

    status(): Promise<RecorderStatus> {
        return this.ops.status();
    }

    pause(): Promise<{ state: ControlState }> {
        return this.ops.pause();
    }

    resume(): Promise<{ state: ControlState }> {
        return this.ops.resume();
    }

    stop(options: { wait?: boolean } = {}): Promise<StopAnswer> {
        return this.ops.stop(options);
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

    override listJobs(): Promise<JobInfo[]> {
        return this.ops.listJobs();
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

    const previous = readFileIfExistsSync(files.pid);
    const content = previous ? Buffer.from(previous).toString("utf8") : undefined;
    const owner = content ? parsePidRecord(content) : null;
    const status = owner ? classifyPidRecord(owner).status : undefined;
    const reclaimed =
        content && (status === "dead" || status === "foreign") ? await attemptStaleTakeover(files.pid, content) : false;

    if (!reclaimed) {
        writePidFile(files.pid, { exclusive: true });
    }

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
        const seenDisplays = new Map<number, string>(
            (record?.recording?.displays ?? []).map((display) => [display.id, display.name])
        );
        const spans: RecordingSpan[] = [...(record?.recording?.spans ?? [])];
        let paused = false;
        let pausedAt: string | undefined;
        let stopRequested = false;
        /** The captures of the running piece, by the display each records. */
        const running = new Map<number, RunningCapture>();
        const pendingCaptures = new Set<RunningCapture>();
        let inPiece = false;
        let wake: (() => void) | undefined;
        const abortAll = () => {
            for (const capture of running.values()) {
                capture.controller.abort();
            }
        };
        const stopping = new AbortController();
        const saveState = () => atomicWriteFileSync(files.state, SafeJSON.stringify(state, null, 2));
        const connected = async (displayId: number): Promise<DisplayInfo> => {
            const display = (await deps.recorder.displays()).find((one) => one.id === displayId);

            if (!display) {
                throw new RpcError(RPC_ERRORS.unknownDisplay, `display ${displayId} is not connected`);
            }

            return display;
        };
        const refuseWhenStopping = () => {
            if (stopRequested) {
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
            abortAll();
            return answer("restart");
        };
        const currentIds = () => chosen ?? state.displays?.map((one) => one.id) ?? [];
        /**
         * Applies changed settings to every running capture: each change through its live command, or, when a capture
         * lacks one, a restart of that capture with the new settings. No capture running: the next piece takes them.
         */
        const applyLive = async (
            changes: Array<((capture: LiveCapture) => Promise<void> | undefined) | undefined>
        ): Promise<"live" | "restart" | "next-piece"> => {
            const wanted = changes.filter((change) => change !== undefined);

            if (running.size === 0 || wanted.length === 0) {
                return "next-piece";
            }

            let restarted = false;

            for (const capture of running.values()) {
                const channel = capture.live;
                const results = channel ? wanted.map((change) => change(channel)) : [undefined];

                if (results.some((result) => result === undefined)) {
                    capture.controller.abort();
                    restarted = true;
                    continue;
                }

                await Promise.all(results);
            }

            return restarted ? "restart" : "live";
        };
        const finishJobId = `finish-${meetingId}-${Date.now()}`;
        const stopped = Promise.withResolvers<StopAnswer>();
        const jobs = new JobRegistry((event) => live.emit("progress", { ...event }));
        const liveStatus = (): RecorderStatus => {
            const entry = live.current;
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
        };
        const session = startRecording({
            recorder: deps.recorder,
            session: {
                id: meetingLiveId(meetingId),
                kind: "meeting",
                title: record?.title || meetingId,
                folder,
                dir: deps.liveDir,
                control: new MeetingRecorderControl({
                    status: async () => liveStatus(),
                    stop: async (options) => {
                        if (stopRequested) {
                            throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is already stopping");
                        }

                        requestStop();
                        return options.wait === false ? { state: "stopping", job: finishJobId } : await stopped.promise;
                    },
                    listJobs: async () => jobs.list(),
                    getSettings: async () => ({ settings, audio: { ...audio, muted: { ...audio.muted } } }),
                    setSettings: async (patch) => {
                        refuseWhenStopping();
                        const before = settings;
                        settings = recorderSettingsSchema.parse({
                            ...settings,
                            ...patch,
                            ocr: { ...settings.ocr, ...patch.ocr },
                        });
                        const applied = await applyLive([
                            settings.activeFps !== before.activeFps || settings.idleFps !== before.idleFps
                                ? (one) => one.setRates?.(settings.activeFps, settings.idleFps)
                                : undefined,
                            settings.threshold !== before.threshold
                                ? (one) => one.setThreshold?.(settings.threshold)
                                : undefined,
                            settings.maxLongSide !== before.maxLongSide
                                ? (one) => one.setMaxLongSide?.(settings.maxLongSide)
                                : undefined,
                            // ax-tool has no live heartbeat command, so a change of it restarts the capture.
                            settings.heartbeatSec !== before.heartbeatSec ? () => undefined : undefined,
                        ]);
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

                        const capture = [...running.values()].find((one) => one.audio);

                        if (capture && !capture.live?.mute) {
                            throw new RpcError(RPC_ERRORS.unsupported, "this recorder cannot mute while it records");
                        }

                        await capture?.live?.mute?.(source, muted).catch((error: unknown) => {
                            throw new RpcError(RPC_ERRORS.internal, errorText(error));
                        });
                        audio.muted[source] = muted;
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
                        const capture = [...running.values()].find((one) => one.audio);

                        if (capture?.live?.setMic) {
                            await capture.live.setMic(deviceId).catch((error: unknown) => {
                                throw new RpcError(RPC_ERRORS.internal, errorText(error));
                            });
                        } else {
                            capture?.controller.abort();
                        }

                        return { ...audio, muted: { ...audio.muted } };
                    },
                    pause: async () => {
                        if (stopRequested) {
                            throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is stopping");
                        }

                        if (paused) {
                            throw new RpcError(RPC_ERRORS.alreadyPaused, "the recording is already paused");
                        }

                        paused = true;
                        pausedAt = new Date().toISOString();
                        const captures = [...running.values()];

                        // A capture with a live channel pauses in place; any other ends its piece.
                        if (captures.length > 0 && captures.every((one) => one.live)) {
                            for (const one of captures) {
                                one.live?.pause();
                            }
                        } else {
                            abortAll();
                        }

                        markPaused();
                        return { state: "paused" };
                    },
                    resume: async () => {
                        if (!paused || stopRequested) {
                            throw new RpcError(RPC_ERRORS.notPaused, "the recording is not paused");
                        }

                        paused = false;

                        for (const one of running.values()) {
                            one.live?.resume();
                        }

                        markResumed();
                        wake?.();
                        return { state: "recording" };
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

                        if (!inPiece || paused || running.has(display.id)) {
                            return answer("next-piece");
                        }

                        startCapture(targetOf(display));
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
                        const capture = running.get(displayId);

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
                        const [only, ...others] = [...running.values()];

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

                            for (const other of others) {
                                other.controller.abort();
                            }

                            running.delete(only.target.displayId);
                            only.target = targetOf(display);
                            running.set(display.id, only);
                            chosen = [display.id];
                            syncDisplays();
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
                }),
            },
        });
        const live = session.live;
        const requestStop = () => {
            stopRequested = true;
            live.update({ state: "stopping" });
            abortAll();
            stopping.abort();
            wake?.();
        };
        const onSignal = () => requestStop();
        process.on("SIGTERM", onSignal);
        process.on("SIGINT", onSignal);

        const updateRecording = (change: string, mutate: (recording: RecordingBlock) => void) =>
            store.update(meetingId, { command: "record", change }, (current) => {
                const recording: RecordingBlock = { ...current.recording };
                mutate(recording);
                current.recording = recording;
            });
        const openSpan = () => spans.push({ from: new Date().toISOString() });
        /** `at`: when it was asked for; the running piece converts its frames after that. */
        const closeSpan = (stopReason: RecordingStopReason, at = new Date().toISOString()) => {
            const open = spans.at(-1);

            if (open && !open.to) {
                open.to = at;
                open.stopReason = stopReason;
            }
        };

        const markPaused = () => {
            closeSpan("paused", pausedAt);
            state.paused = true;
            saveState();
            live.update({ state: "paused" });
            void updateRecording("paused", (recording) => {
                recording.status = "paused";
                recording.spans = spans;
            }).catch((err: unknown) => log.warn({ err }, "pause not written to the record"));
        };
        const markResumed = () => {
            openSpan();
            state.paused = false;
            saveState();
            live.update({ state: "recording" });
            void updateRecording("resumed", (recording) => {
                recording.status = "recording";
                recording.spans = spans;
            }).catch((err: unknown) => log.warn({ err }, "resume not written to the record"));
        };
        const targetOf = (display: DisplayInfo): PieceTarget => ({
            target: { kind: "display", displayId: display.id },
            displayId: display.id,
            label: `${display.name} (${display.id})`,
        });
        const liveFrames = () => state.frames + [...running.values()].reduce((sum, one) => sum + one.streamed, 0);
        let lastDisplayIds = "";
        /** The recorded displays follow the running captures. */
        const syncDisplays = () => {
            const ids = [...running.keys()].sort((a, b) => a - b).join(",");

            if (ids === lastDisplayIds || running.size === 0) {
                return;
            }

            log.info({ from: lastDisplayIds, to: ids }, "recorded displays changed");
            lastDisplayIds = ids;
            state.displays = [...running.values()].map((one) => ({
                id: one.target.displayId,
                name: seenDisplays.get(one.target.displayId) ?? one.target.label,
            }));
            live.update({ displays: state.displays });
        };
        let pieceOutcome: { recorded: boolean; lastError?: unknown; count: number } = { recorded: false, count: 0 };
        let captureSeq = 0;

        const startCapture = (target: PieceTarget): void => {
            const outDir = join(pieceDir, `d${target.displayId}-${++captureSeq}`);
            mkdirSync(outDir, { recursive: true });
            // One capture records the sound: two would write the same microphone twice.
            const withAudio =
                audio.sources.length > 0 &&
                deps.recorder.supports.audio &&
                ![...running.values()].some((one) => one.audio);
            const entry: RunningCapture = {
                target,
                controller: new AbortController(),
                streamed: 0,
                audio: withAudio,
                done: Promise.resolve(),
            };
            running.set(target.displayId, entry);
            pendingCaptures.add(entry);
            pieceOutcome.count += 1;
            syncDisplays();
            const hooks: CaptureHooks = {
                onFrame: (frame) => {
                    entry.streamed += 1;
                    live.update({ frames: liveFrames(), lastFrameAt: new Date().toISOString() });
                    live.emit("frame", {
                        displayId: frame.displayId ?? entry.target.displayId,
                        at: new Date().toISOString(),
                        file: frame.path,
                    });
                },
                onLive: (channel) => {
                    entry.live = channel;

                    if (paused) {
                        channel.pause();
                    }

                    for (const source of withAudio ? audio.sources : []) {
                        if (audio.muted[source]) {
                            void channel.mute?.(source, true).catch((err: unknown) => log.warn({ err }, "mute failed"));
                        }
                    }
                },
            };
            entry.done = session
                .capture(
                    {
                        target: target.target,
                        durationSec: deps.pieceSec,
                        activeFps: settings.activeFps,
                        idleFps: settings.idleFps,
                        thresholdPercent: settings.threshold,
                        maxLongSidePx: settings.maxLongSide,
                        ...nativeKeys,
                        heartbeatSec: settings.heartbeatSec,
                        ...(withAudio
                            ? {
                                  audio: {
                                      sources: audio.sources,
                                      ...(audio.micDevice ? { micDeviceId: audio.micDevice } : {}),
                                  },
                              }
                            : {}),
                        outDir,
                        hooks,
                    },
                    entry.controller.signal
                )
                .then(
                    async (result) => {
                        pieceOutcome.recorded = true;
                        keepTracks(result, entry.target);
                        await jobs.task("ocr", (ctx) =>
                            keepFrames(result, entry.target, entry.streamed > 0, (done) =>
                                ctx.progress({ done, total: result.frames.length, unit: "frames" })
                            )
                        ).done;
                        entry.streamed = 0;

                        if (result.endedEarly === "display-removed") {
                            log.info({ display: entry.target.label }, "a display left during a piece");
                        }
                    },
                    (err: unknown) => {
                        pieceOutcome.lastError = err;

                        if (err instanceof CaptureError && err.kind === "display-missing") {
                            log.info({ display: entry.target.label }, "a display left before its capture");
                            return;
                        }

                        log.warn({ err, display: entry.target.label }, "a capture failed");

                        if (pieceOutcome.count > 1) {
                            note(`${entry.target.label}: ${errorText(err)}`);
                        }
                    }
                )
                .finally(() => {
                    if (running.get(entry.target.displayId) === entry) {
                        running.delete(entry.target.displayId);
                    }

                    pendingCaptures.delete(entry);
                    rmSync(outDir, { recursive: true, force: true });
                });
        };

        let failures = 0;
        let failureNoticeOpen = Boolean(record?.recording?.failureNotifiedAt);
        let runFrames = 0;
        let lastConnected = "";

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
        const keepFrames = async (
            result: CaptureResult,
            target: PieceTarget,
            streamed: boolean,
            onFrame: (done: number) => void = () => undefined
        ): Promise<void> => {
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
                    live.emit("frame", { displayId: kept.displayId, at: kept.at.toISOString(), file: kept.path });
                }

                done += 1;
                onFrame(done);
            }
        };

        /** One piece: every target at once. False when every capture failed. */
        const capturePiece = async (): Promise<boolean> => {
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
                live.emit("displays", {
                    connected: displays.map((display) => ({ id: display.id, name: display.name })),
                    removed: [...before].filter((id) => !now.has(id)),
                });
                lastConnected = connectedIds;
            }

            if (fallback) {
                note(`${fallback} (since ${localTime(new Date().toISOString())})`);
            }

            for (const display of displays) {
                seenDisplays.set(display.id, display.name);
            }

            if (targets.length === 0) {
                throw new CaptureError("display-missing", "no display is connected");
            }

            if (paused || stopRequested) {
                return false;
            }

            pieceOutcome = { recorded: false, count: 0 };
            inPiece = true;

            try {
                for (const target of targets) {
                    startCapture(target);
                }

                // A display added over the socket joins this piece, so wait until every capture has ended.
                while (pendingCaptures.size > 0) {
                    await Promise.race([...pendingCaptures].map((one) => one.done));
                }
            } catch (err) {
                abortAll();
                await Promise.allSettled([...pendingCaptures].map((one) => one.done));
                throw err;
            } finally {
                inPiece = false;
            }

            if (!pieceOutcome.recorded && !paused && !stopRequested && pieceOutcome.lastError !== undefined) {
                throw pieceOutcome.lastError;
            }

            return pieceOutcome.recorded;
        };

        try {
            rmSync(pieceDir, { recursive: true, force: true });
            mkdirSync(pieceDir, { recursive: true });
            saveState();
            openSpan();
            await store.update(
                meetingId,
                { command: "record start", change: `display ${policy} (${deps.recorder.id})` },
                (current) => {
                    current.recording = {
                        ...current.recording,
                        startedAt: state.startedAt,
                        backend: deps.recorder.id,
                        displayPolicy: policy,
                        framesDir: "frames",
                        ocr: "ocr.jsonl",
                        status: "recording",
                        spans,
                    };
                    delete current.recording.stoppedAt;
                    delete current.recording.stopReason;
                }
            );
            await session.ready();

            while (!stopRequested) {
                if (paused) {
                    await new Promise<void>((resolve) => {
                        wake = resolve;

                        if (!paused || stopRequested) {
                            resolve();
                        }
                    });
                    wake = undefined;

                    if (stopRequested) {
                        break;
                    }
                }

                try {
                    const recorded = await capturePiece();

                    if (recorded) {
                        failures = 0;
                    }

                    if (recorded && failureNoticeOpen) {
                        failureNoticeOpen = false;
                        await updateRecording("capture works again", (recording) => {
                            delete recording.failureNotifiedAt;
                        });
                    }
                } catch (err) {
                    // Only a capture fails a piece; anything else (a frame that cannot be converted) ends the recording.
                    if (!(err instanceof CaptureError)) {
                        throw err;
                    }

                    failures += 1;
                    log.warn({ err, failures }, "capture piece failed");

                    if (failures >= MAX_FAILURES) {
                        note(`capture failed ${failures} times in a row: ${errorText(err)}`);
                        state.stopReason = "failed";
                        break;
                    }

                    await abortableSleep(deps.failurePauseMs, stopping.signal).catch(() => undefined);
                }

                state.warning = notes.length > 0 ? notes.join("; ") : undefined;
                live.update({ frames: liveFrames(), lastFrameAt: state.lastFrameAt, warning: state.warning });
                saveState();
            }
        } catch (err) {
            log.error({ err, meetingId }, "the recorder stopped on an error");
            note(`the recorder stopped on an error: ${errorText(err)}`);
            state.stopReason = "error";
        } finally {
            process.off("SIGTERM", onSignal);
            process.off("SIGINT", onSignal);
            rmSync(pieceDir, { recursive: true, force: true });
        }

        try {
            const finished = await jobs.run({
                kind: "finish",
                id: finishJobId,
                initial: [] as string[],
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
                            return current ? (await collectRecord(store, current)).notes.map((one) => one.text) : [];
                        },
                    },
                ],
            }).done;
            stopped.resolve({
                state: "stopped",
                outcome: state.stopReason,
                job: finishJobId,
                frames: state.frames,
                notes: finished.state,
            });
        } catch (err) {
            log.error({ err, meetingId }, "the recording summary could not be written");
            stopped.resolve({ state: "stopped", outcome: state.stopReason, job: finishJobId, frames: state.frames });
        } finally {
            // A waiting `stop` call gets its answer before the socket closes.
            await Bun.sleep(STOP_ANSWER_MS);
            live.close(state.stopReason);

            if (existsSync(files.state)) {
                renameSync(files.state, join(folder, "recorder-last.json"));
            }
        }

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
                    const recording: RecordingBlock = {
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
                        displays: [...seenDisplays].map(([id, name]) => ({
                            id,
                            name,
                            frames: total.perDisplay.get(id) ?? 0,
                        })),
                        ...(clock ? { clock } : {}),
                        ...(notifyFailure ? { failureNotifiedAt: stoppedAt } : {}),
                    };

                    if (state.warning) {
                        recording.warning = state.warning;
                    } else {
                        delete recording.warning;
                    }

                    next.recording = recording;
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
    } finally {
        clearPidFile(files.pid);
    }
}

/** The live displays of a recorder state, for `record status`. */
export function stateDisplays(state: RecorderState): string {
    return state.displays?.length
        ? state.displays.map((display) => `${display.name} (${display.id})`).join(", ")
        : String(state.display);
}
