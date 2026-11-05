import type { JobInfo } from "@genesiscz/utils/jobs";
import { JSON_RPC_ERRORS, RPC_CANCELLED, RpcError } from "@genesiscz/utils/rpc/errors";
import { z } from "zod";
import type { DisplayInfo } from "./types";

/** Every method a recorder can serve, by its JSON-RPC name. A recorder lists the ones it implements in `methods`. */
export const RECORDER_METHODS = [
    "status",
    "pause",
    "resume",
    "stop",
    "discard",
    "restart",
    "target.switch",
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
    "marker.add",
] as const;
export type RecorderMethod = (typeof RECORDER_METHODS)[number];

export const RECORDER_STATES = ["recording", "paused", "stopping"] as const;
export type RecorderState = (typeof RECORDER_STATES)[number];

/** JSON-RPC 2.0 error codes: the standard ones, and the recorder's own from 1001. */
export const RPC_ERRORS = {
    ...JSON_RPC_ERRORS,
    unknownDisplay: 1001,
    notPaused: 1002,
    alreadyStopped: 1003,
    alreadyPaused: 1004,
    lastDisplay: 1005,
    unsupported: 1006,
    unknownDevice: 1007,
    /** The recorder service's `hello`: another protocol, or a second host while the first is connected. */
    protocolMismatch: 1011,
    hostTaken: 1012,
    /** A `$/cancel` stopped the request; the transport answers it (`@genesiscz/utils/rpc`). */
    cancelled: RPC_CANCELLED,
    /** The host's `camera.start`: macOS denied the camera, or another app holds it. */
    cameraDenied: 1014,
    cameraBusy: 1015,
    /** The recorder service's edit sessions: another writer changed the edit, or a call named an older revision. */
    staleRevision: 1016,
    nothingToUndo: 1017,
    nothingToRedo: 1018,
    /** A host method no connected host answered, and no headless way does it (the camera). */
    hostUnavailable: 1019,
} as const;

export { RpcError };

export interface RecorderStatus {
    kind: string;
    title: string;
    state: RecorderState;
    displays: Array<{ id: number; name: string }>;
    frames: number;
    lastFrameAt?: string;
    warning?: string;
    folder?: string;
    /** A movie recording: the recorded time so far (pauses left out), its limit and the segments written. */
    elapsedMs?: number;
    limitMs?: number;
    segments?: number;
}

export type DisplayEntry = DisplayInfo & { recorded: boolean };

export const AUDIO_SOURCES = ["mic", "system"] as const;
export type AudioSource = (typeof AUDIO_SOURCES)[number];

export interface AudioDevice {
    /** The device UID, which `audio.setInput` takes. */
    id: string;
    name: string;
    channels: number;
    default: boolean;
}

export interface AudioDevices {
    inputs: AudioDevice[];
    outputs: AudioDevice[];
}

/** What a recording records as sound: the sources, which of them are muted now, and the microphone it uses. */
export interface AudioState {
    sources: AudioSource[];
    muted: Record<AudioSource, boolean>;
    micDevice?: string;
}

/** The settings a running recording takes live; `settings.set` takes any part of them. */
export const recorderSettingsSchema = z.object({
    /** Frames per second while the screen changes. */
    activeFps: z.number().min(0.5).max(120),
    /** Frames per second while it does not. */
    idleFps: z.number().min(0.1).max(5),
    /** The share of the frame that must change for a new frame, in percent. */
    threshold: z.number().min(0).max(100),
    /** The longest side of a kept frame in pixels. */
    maxLongSide: z.number().int().min(320).max(16_384),
    /** A frame at least this often while nothing changes; 0 is off. */
    heartbeatSec: z.number().min(0).max(3600),
    ocr: z.object({
        enabled: z.boolean(),
        /** Vision OCR languages, in order of preference. */
        languages: z.array(z.string().trim().min(1)).min(1),
        /** OCR text shorter than this is stored as no text. */
        minChars: z.number().int().min(0).max(1000),
    }),
});
export type RecorderSettings = z.infer<typeof recorderSettingsSchema>;
export const recorderSettingsPatchSchema = recorderSettingsSchema
    .omit({ ocr: true })
    .partial()
    .extend({ ocr: recorderSettingsSchema.shape.ocr.partial().optional() })
    .strict();
export type RecorderSettingsPatch = z.infer<typeof recorderSettingsPatchSchema>;

export interface SettingsAnswer {
    settings: RecorderSettings;
    audio: AudioState;
    /** How the change took effect on the running captures. */
    applied?: "live" | "restart" | "next-piece";
}

/** `all`, `follow-focus`, `main` or a screen index. */
export const displayModeSchema = z.union([z.enum(["all", "follow-focus", "main"]), z.number().int().nonnegative()]);
export type DisplayMode = z.infer<typeof displayModeSchema>;

export interface DisplaySelection {
    mode: DisplayMode;
    /** The displays chosen by id over the policy, or null when the policy decides. */
    chosen: number[] | null;
    /** How the change took effect: on the running capture, a capture started or stopped, a restart, the next piece. */
    applied: "live" | "started" | "stopped" | "restart" | "next-piece";
}

export interface StopAnswer {
    state: "stopping" | "stopped";
    /** How the recording ended: `requested`, `failed`, `done`, `discarded`, … */
    outcome?: string;
    /** The post-processing job; with `wait: false` the answer comes before it ends. */
    job?: string;
    frames?: number;
    /** What post-processing reported, one line each. */
    notes?: string[];
}

function unsupported(kind: string, method: RecorderMethod): never {
    throw new RpcError(RPC_ERRORS.unsupported, `a ${kind} recording has no ${method}`);
}

/**
 * The control surface of one running recording, the same for every recorder kind: the meetings recorder, the control
 * capture session, and a remote one over the live recording socket (`RecorderClient`). A kind implements what it has
 * and lists it in `methods`; the rest answers `unsupported`.
 */
/** A moment of a recording an agent or the user marked, at its time in the movie. */
export interface RecordingMarker {
    atMs: number;
    label: string;
}

/** The answer of every kind to `marker.add` while the recording does not record (paused, stopping). */
export function refuseMarker(state: string): never {
    throw new RpcError(RPC_ERRORS.unsupported, `a marker needs a running recording; this one is ${state}`);
}

export abstract class RecorderControl {
    abstract readonly kind: string;
    abstract readonly methods: readonly RecorderMethod[];

    abstract status(): Promise<RecorderStatus>;
    abstract pause(): Promise<{ state: RecorderState }>;
    abstract resume(): Promise<{ state: RecorderState }>;
    /** Answers after post-processing; with `wait: false` at once, with the post-processing job. */
    abstract stop(options?: { wait?: boolean }): Promise<StopAnswer>;

    /** Ends the recording and deletes what it recorded. */
    async discard(): Promise<StopAnswer> {
        return unsupported(this.kind, "discard");
    }

    /** Deletes what was recorded so far and records again. */
    async restart(): Promise<{ state: RecorderState }> {
        return unsupported(this.kind, "restart");
    }

    /** Records another target of the recorder's own kind (a window, an app, a display). */
    async switchTarget(_target: unknown): Promise<{ state: RecorderState }> {
        return unsupported(this.kind, "target.switch");
    }

    async listDisplays(): Promise<DisplayEntry[]> {
        return unsupported(this.kind, "displays.list");
    }

    async addDisplay(_displayId: number): Promise<DisplaySelection> {
        return unsupported(this.kind, "displays.add");
    }

    async removeDisplay(_displayId: number): Promise<DisplaySelection> {
        return unsupported(this.kind, "displays.remove");
    }

    async switchDisplay(_displayId: number): Promise<DisplaySelection> {
        return unsupported(this.kind, "displays.switch");
    }

    async setDisplayMode(_mode: DisplayMode): Promise<DisplaySelection> {
        return unsupported(this.kind, "displays.mode");
    }

    /** The post-processing jobs (OCR backlog, segment join, meeting refresh and collect), newest last. */
    async listJobs(): Promise<JobInfo[]> {
        return [];
    }

    async listAudioDevices(): Promise<AudioDevices> {
        return unsupported(this.kind, "audio.list");
    }

    /** Mutes or unmutes a recorded source; the track keeps its length (silence while muted). */
    async muteAudio(_source: AudioSource, _muted: boolean): Promise<AudioState> {
        return unsupported(this.kind, "audio.mute");
    }

    /** Records the microphone from this input device (an `audio.list` id). */
    async setAudioInput(_deviceId: string): Promise<AudioState> {
        return unsupported(this.kind, "audio.setInput");
    }

    /** Marks this moment of the recording with a label; the editor lists it at its movie time. */
    async addMarker(_label: string): Promise<RecordingMarker> {
        return unsupported(this.kind, "marker.add");
    }

    async getSettings(): Promise<SettingsAnswer> {
        return unsupported(this.kind, "settings.get");
    }

    async setSettings(_patch: RecorderSettingsPatch): Promise<SettingsAnswer> {
        return unsupported(this.kind, "settings.set");
    }
}

const displayIdParams = z.object({ displayId: z.number().int() });

function parse<T>(schema: z.ZodType<T>, params: unknown, hint: string): T {
    const parsed = schema.safeParse(params ?? {});

    if (!parsed.success) {
        throw new RpcError(RPC_ERRORS.invalidParams, `give ${hint}`);
    }

    return parsed.data;
}

/** One entry per method: how its JSON-RPC params reach the RecorderControl method. */
export const RECORDER_DISPATCH: Record<
    RecorderMethod,
    (control: RecorderControl, params: unknown) => Promise<unknown>
> = {
    status: (control) => control.status(),
    pause: (control) => control.pause(),
    resume: (control) => control.resume(),
    stop: (control, params) =>
        control.stop(parse(z.object({ wait: z.boolean().optional() }), params, "{ wait?: boolean }")),
    discard: (control) => control.discard(),
    restart: (control) => control.restart(),
    "target.switch": (control, params) =>
        control.switchTarget(parse(z.object({ target: z.unknown() }), params, "{ target }").target),
    "displays.list": (control) => control.listDisplays(),
    "displays.add": (control, params) =>
        control.addDisplay(parse(displayIdParams, params, "{ displayId: <number> }").displayId),
    "displays.remove": (control, params) =>
        control.removeDisplay(parse(displayIdParams, params, "{ displayId: <number> }").displayId),
    "displays.switch": (control, params) =>
        control.switchDisplay(parse(displayIdParams, params, "{ displayId: <number> }").displayId),
    "displays.mode": (control, params) =>
        control.setDisplayMode(
            parse(z.object({ mode: displayModeSchema }), params, "{ mode: all | follow-focus | main | <index> }").mode
        ),
    "jobs.list": (control) => control.listJobs(),
    "audio.list": (control) => control.listAudioDevices(),
    "audio.mute": (control, params) => {
        const { source, muted } = parse(
            z.object({ source: z.enum(AUDIO_SOURCES), muted: z.boolean().default(true) }),
            params,
            "{ source: mic | system, muted?: boolean }"
        );
        return control.muteAudio(source, muted);
    },
    "audio.setInput": (control, params) =>
        control.setAudioInput(parse(z.object({ deviceId: z.string().min(1) }), params, "{ deviceId }").deviceId),
    "marker.add": (control, params) =>
        control.addMarker(
            parse(z.object({ label: z.string().trim().min(1).max(80) }), params, "{ label: <1 to 80 characters> }")
                .label
        ),
    "settings.get": (control) => control.getSettings(),
    "settings.set": (control, params) =>
        control.setSettings(
            parse(
                recorderSettingsPatchSchema,
                params,
                "any of { activeFps, idleFps, threshold, maxLongSide, heartbeatSec, ocr: { enabled, languages, minChars } }"
            )
        ),
};

export function isRecorderMethod(name: string): name is RecorderMethod {
    return (RECORDER_METHODS as readonly string[]).includes(name);
}
