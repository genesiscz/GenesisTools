import type { AudioLevelBlock } from "./audio-levels";
import type { LaunchFailure, LaunchTarget, QuitOutcome } from "./capture-blockers";
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

/**
 * Where a capture takes its frames: the ScreenCaptureKit stream, a screenshot per frame (no open stream), or the
 * recorder's choice (screenshots on a display with a never-capture window, the stream elsewhere).
 */
export const FRAME_SOURCES = ["stream", "screenshot", "auto"] as const;
export type FrameSource = (typeof FRAME_SOURCES)[number];
/** The source a capture really used. */
export type UsedFrameSource = Exclude<FrameSource, "auto">;

/**
 * An app that keeps a never-capture window (`NSWindow.sharingType = .none`) on a display, as `ax-tool capture-blockers`
 * lists it. Such a window makes WindowServer draw every window again for each open capture stream on that display.
 */
export interface CaptureBlocker {
    pid: number;
    name: string;
    bundleId?: string;
    path?: string;
    /** The process launch time ax-tool reads, so a quit reaches this process and never a newer one with the same pid. */
    processLaunch?: number;
    windows: number;
    /** The CGDirectDisplayIDs its never-capture windows are on. */
    displays: number[];
}

/** The stderr event of a controlled capture at its start: the frame source it chose, and why. */
export interface FrameSourceEvent {
    source: UsedFrameSource;
    displayId?: number;
    /** The apps with a never-capture window on the display(s) the choice looked at; empty when there are none. */
    neverCapture: CaptureBlocker[];
}

/** The stderr event of a capture that takes its frames by screenshot: how long one takes, and how far that stretched the interval. */
export interface ScreenshotPaceEvent {
    /** One screenshot every this many seconds; absent while the asked frame rate holds. */
    everySec?: number;
    /** How long the newest screenshot took. */
    screenshotSec: number;
}

export interface CaptureRequest {
    target: CaptureTarget;
    /** CG window IDs the display filter must exclude. */
    excludeWindowIds?: number[];
    /** Keep the windows of screen dimmers (HazeOver and the like), which the display filter leaves out by default. */
    keepOverlays?: boolean;
    /** Unset is the stream (`supports.frameSource`). */
    frameSource?: FrameSource;
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
    /** The file's second 0 relative to `CaptureResult.startedAtMs`, from ax-tool's `startMs`. Absent from an older ax-tool. */
    startOffsetMs?: number;
    /** `[fromMs, toMs]` on the audio file's timeline while the source was muted. */
    mutedSpans: Array<[number, number]>;
    /** Missing samples replaced by silence, in milliseconds on the file timeline. */
    lostSpans?: Array<[number, number]>;
    /** What went wrong with this track (its sidecar did not start or finish); a track without `path` lost its sound. */
    warnings?: string[];
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
    onLevels?: (block: AudioLevelBlock) => void;
    /** A frame the recorder kept, as it lands; its `path` is the recorder's own file until the capture ends. */
    onFrame?: (frame: CapturedFrame) => void;
    /** The capture accepts commands from now on. */
    onLive?: (capture: LiveCapture) => void;
    /** The frame source the capture chose at its start (`supports.frameSource` with `supports.liveControl`). */
    onFrameSource?: (event: FrameSourceEvent) => void;
    /** The pace of a capture that takes screenshots, after its first one and when its whole seconds change. */
    onScreenshotPace?: (event: ScreenshotPaceEvent) => void;
}

export type MotionBox = [number, number, number, number];

export interface CapturedFrame {
    path: string;
    /** Milliseconds after `startedAtMs`. */
    atMs: number;
    displayId?: number;
    /** The display holding the focused window at capture time, including in all-display mode. */
    focusedDisplayId?: number;
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
    /** The source the frames came from; absent from a recorder or an ax-tool without `supports.frameSource`. */
    frameSource?: UsedFrameSource;
    /** The apps with a never-capture window on the display(s) the frame source choice looked at, when there are any. */
    neverCapture?: CaptureBlocker[];
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
    /** `CaptureRequest.frameSource` other than the stream. */
    frameSource: boolean;
    /** `captureBlockers()`, `quitApps()` and `launchApps()`. */
    captureBlockers: boolean;
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

    /**
     * The apps with a never-capture window on any display. Undefined when this recorder cannot list them, which is not
     * the same as none; throws a CaptureError when the listing failed.
     */
    async captureBlockers(): Promise<CaptureBlocker[] | undefined> {
        return undefined;
    }

    /** Asks each app to quit (`supports.captureBlockers`) and says which ones are gone after a short wait. */
    async quitApps(_apps: CaptureBlocker[]): Promise<QuitOutcome> {
        throw new CaptureError("unavailable", `the ${this.id} recorder cannot quit apps`);
    }

    /** Starts each app again in the background (`supports.captureBlockers`); answers the ones that did not start. */
    async launchApps(_apps: LaunchTarget[]): Promise<LaunchFailure[]> {
        throw new CaptureError("unavailable", `the ${this.id} recorder cannot start apps`);
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
