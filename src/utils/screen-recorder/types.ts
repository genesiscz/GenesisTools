import type { AudioDevices, AudioSource } from "./control";

export const FRAME_RECORDER_IDS = ["native", "peekaboo"] as const;
export type FrameRecorderId = (typeof FRAME_RECORDER_IDS)[number];

export interface DisplayInfo {
    /** The CGDirectDisplayID: stays the same while the display is connected, unlike its index. */
    id: number;
    index: number;
    name: string;
    main: boolean;
    widthPt: number;
    heightPt: number;
    scale: number;
}

export type CaptureTarget = { kind: "display"; displayId: number } | { kind: "follow-focus" };

export interface CaptureRequest {
    target: CaptureTarget;
    /** At most 180. */
    durationSec: number;
    activeFps: number;
    idleFps: number;
    /** The share of the frame that must change for a new frame, in percent (0 to 100). */
    thresholdPercent: number;
    maxLongSidePx?: number;
    heartbeatSec?: number;
    quietMs?: number;
    maxFrames?: number;
    maxMb?: number;
    /** Where the frames go; the recorder creates it. */
    outDir: string;
    /** Called while the capture runs, by a recorder that can (`supports.liveControl`). */
    hooks?: CaptureHooks;
    /** Sound beside the frames, as one `.m4a` per source in `outDir` (`supports.audio`). */
    audio?: { sources: AudioSource[]; micDeviceId?: string };
}

/** One recorded sound source of a capture. */
export interface AudioTrack {
    source: AudioSource;
    /** The `.m4a` file, in the capture's `outDir`. */
    path?: string;
    durationMs: number;
    peakDbfs?: number;
    /** `[fromMs, toMs]` on the audio file's timeline while the source was muted. */
    mutedSpans: Array<[number, number]>;
}

/** A running capture that takes commands while it records, without a restart. */
export interface LiveCapture {
    /** Resolves when the stream shows the display; rejects with a CaptureError (`display-missing`, `timeout`). */
    switchDisplay(displayId: number): Promise<void>;
    pause(): void;
    resume(): void;
    /** The live settings this capture takes without a restart; absent when the recorder has no such command. */
    setRates?(active: number, idle: number): Promise<void>;
    setThreshold?(percent: number): Promise<void>;
    setMaxLongSide?(px: number): Promise<void>;
    mute?(source: AudioSource, muted: boolean): Promise<void>;
    setMic?(deviceId: string): Promise<void>;
}

export interface CaptureHooks {
    /** A frame the recorder kept, as it lands; its `path` is the recorder's own file until the capture ends. */
    onFrame?: (frame: CapturedFrame) => void;
    /** The capture accepts commands from now on. */
    onLive?: (capture: LiveCapture) => void;
}

export type MotionBox = [number, number, number, number];

export interface CapturedFrame {
    path: string;
    /** Milliseconds after `startedAtMs`. */
    atMs: number;
    displayId?: number;
    changePercent: number;
    reason: string;
    motionBoxes?: MotionBox[];
}

export const CAPTURE_ENDINGS = ["display-removed", "stream-error", "stopped"] as const;
export type CaptureEnding = (typeof CAPTURE_ENDINGS)[number];

export interface CaptureResult {
    /** Wall-clock time of `atMs` 0. */
    startedAtMs: number;
    frames: CapturedFrame[];
    endedEarly?: CaptureEnding;
    stats?: Record<string, number>;
    tracks?: AudioTrack[];
    warnings?: string[];
}

export const CAPTURE_ERROR_KINDS = ["display-missing", "no-permission", "unavailable", "timeout", "failed"] as const;
export type CaptureErrorKind = (typeof CAPTURE_ERROR_KINDS)[number];

/** A capture that produced no result. The message names the capture tool's own error. */
export class CaptureError extends Error {
    readonly kind: CaptureErrorKind;

    constructor(kind: CaptureErrorKind, message: string) {
        super(message);
        this.name = "CaptureError";
        this.kind = kind;
    }
}

export interface FrameRecorderSupport {
    followFocus: boolean;
    displayId: boolean;
    motionBoxes: boolean;
    heartbeat: boolean;
    /** Frames as they land and commands to a running capture (`CaptureHooks`). */
    liveControl: boolean;
    /** Several captures at once (one per display); peekaboo holds one exclusive ScreenCaptureKit lock. */
    parallelCaptures: boolean;
    /** Sound beside the frames (`CaptureRequest.audio`) and the input device list. */
    audio: boolean;
}

/** A change-aware screen recorder: frames only when the screen changed, as image files. */
export abstract class FrameRecorder {
    abstract readonly id: FrameRecorderId;
    abstract readonly supports: FrameRecorderSupport;
    abstract available(): Promise<{ ok: true } | { ok: false; reason: string }>;
    abstract displays(): Promise<DisplayInfo[]>;
    /** Resolves with the frames kept so far when `signal` aborts; throws CaptureError when nothing was recorded. */
    abstract capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult>;

    /** The audio inputs and outputs, for a recorder with `supports.audio`. */
    async audioDevices(): Promise<AudioDevices> {
        throw new CaptureError("unavailable", `the ${this.id} recorder records no sound`);
    }
}

/** What a recorder needs from the tool that hosts it. */
export interface FrameRecorderContext {
    /** The ax-tool command (its binary, built first when its sources changed: the control tool's `ensureBinaryAsync`). */
    axTool: (options: { signal?: AbortSignal; onBuild?: () => void }) => Promise<string[]>;
    /** How a capture is started; default the GenesisTools.app launcher, so the Screen Recording grant is the app's. */
    launch?: (argv: string[]) => string[];
}

/** A capture may run this much longer than its duration before it counts as hung. */
export const CAPTURE_TIMEOUT_GRACE_MS = 30_000;
export const MAX_CAPTURE_SECONDS = 180;
