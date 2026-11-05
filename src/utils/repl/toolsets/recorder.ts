import { basename, join } from "node:path";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { withTimeout } from "@genesiscz/utils/async";
import type { JobInfo } from "@genesiscz/utils/jobs";
import { logger } from "@genesiscz/utils/logger";
import {
    AUDIO_SOURCES,
    type AudioSource,
    displayModeSchema,
    type RecorderMethod,
    type RecorderSettingsPatch,
    type RecorderStatus,
    type RecordingMarker,
    RPC_ERRORS,
    RpcError,
    recorderSettingsPatchSchema,
    type StopAnswer,
} from "@genesiscz/utils/screen-recorder/control";
import { FRAME_NAMINGS, OCR_SINK_KINDS } from "@genesiscz/utils/screen-recorder/frame-output";
import { type LiveNotification, listLiveRecordings, RecorderClient } from "@genesiscz/utils/screen-recorder/live";
import {
    FRAME_FLUSHES,
    type LibraryRecording,
    type StartRecordingOptions,
    startRecording,
} from "@genesiscz/utils/screen-recorder/start";
import type { FrameRecorder } from "@genesiscz/utils/screen-recorder/types";
import { z } from "zod";
import { ReplToolset, type ToolsetContext } from "../toolset";

const { log } = logger.scoped("repl-recorder");

export const recorderStartSchema = z
    .object({
        title: z.string().optional(),
        displays: z.union([z.enum(["all", "main"]), z.array(z.number().int())]).default("main"),
        audio: z
            .object({ mic: z.boolean().optional(), system: z.boolean().optional(), micDeviceId: z.string().optional() })
            .optional(),
        fps: z.number().min(0.5).max(120).optional(),
        idleFps: z.number().min(0.1).max(5).optional(),
        threshold: z.number().min(0).max(100).optional(),
        maxLongSide: z.number().int().min(320).max(16_384).optional(),
        heartbeatSec: z.number().min(0).max(3600).optional(),
        ocr: z
            .object({
                enabled: z.boolean().optional(),
                languages: z.array(z.string()).optional(),
                minChars: z.number().int().optional(),
            })
            .optional(),
        /** Where each frame's OCR goes: `<frame>.ocr.json` beside it (default) or an `ocr.jsonl` row per frame. */
        ocrSink: z.enum(OCR_SINK_KINDS).optional(),
        /** How frames are written: format, JPEG quality, naming, and whether a piece's frames land as it ends. */
        frames: z
            .object({
                format: z.enum(["original", "jpeg"]).optional(),
                jpegQuality: z.number().min(0.1).max(1).optional(),
                naming: z.enum(FRAME_NAMINGS).optional(),
                flush: z.enum(FRAME_FLUSHES).optional(),
            })
            .strict()
            .optional(),
        maxDurationSec: z.number().min(1).max(7200).optional(),
        pieceSec: z.number().min(5).max(180).optional(),
    })
    .strict();

/**
 * What `startRecording` takes for the options of `recorder.start()` (also `tools recorder start --frames`): an OCR
 * block that does not say `enabled` turns OCR on.
 */
export function libraryStartOptions(
    options: z.infer<typeof recorderStartSchema>
): Omit<StartRecordingOptions, "recorder"> {
    return { ...options, ocr: options.ocr ? { ...options.ocr, enabled: options.ocr.enabled ?? true } : undefined };
}

/** `set` takes `fps` for the active rate, as `start` does. */
export const recorderSetSchema = recorderSettingsPatchSchema
    .omit({ activeFps: true })
    .extend({ fps: z.number().min(0.5).max(120).optional() });

/** What every toolset that controls a live recording says about reading and changing its settings. */
export const RECORDER_SETTINGS_DOC = "The live settings and the audio state.";
export const RECORDER_SET_SETTINGS_DOC =
    "Changes fps, idleFps, threshold, maxLongSide, heartbeatSec or ocr while it records.";

/** The patch the live socket takes (`settings.set`) from what a REPL caller gave (`fps` is the active rate). */
export function settingsPatchOf(input: z.input<typeof recorderSetSchema>): RecorderSettingsPatch {
    const { fps, ...rest } = recorderSetSchema.parse(input);
    return { ...rest, ...(fps !== undefined ? { activeFps: fps } : {}) };
}
const EVENTS = ["state", "frame", "displays", "warning", "progress", "ended"] as const;
const statusSchema = z.custom<RecorderStatus>();

const recordingMethods = [
    defineMethod({
        name: "status",
        params: z.object({}),
        result: statusSchema,
        resultName: "RecorderStatus",
        doc: "The state, displays, frame count and folder.",
        effect: "read",
    }),
    defineMethod({
        name: "pause",
        params: z.object({}),
        result: z.object({ state: z.string() }),
        doc: "Pauses the capture in place.",
        effect: "reversible",
    }),
    defineMethod({
        name: "resume",
        params: z.object({}),
        result: z.object({ state: z.string() }),
        doc: "Resumes a paused recording.",
        effect: "reversible",
    }),
    defineMethod({
        name: "stop",
        params: z.object({ wait: z.boolean().optional() }),
        result: z.custom<StopAnswer>(),
        resultName: "{ state, outcome, job, frames, notes, recordingId }",
        doc: 'Stops and resolves after post-processing (watch it with on("progress")); { wait: false } answers at once with the job id.',
        effect: "reversible",
    }),
    defineMethod({
        name: "discard",
        params: z.object({}),
        result: z.custom<StopAnswer>(),
        resultName: "StopAnswer",
        doc: "Stops and deletes what was recorded.",
        effect: "destructive",
    }),
    defineMethod({
        name: "settings",
        params: z.object({}),
        result: z.unknown(),
        resultName: "{ settings, audio }",
        doc: RECORDER_SETTINGS_DOC,
        effect: "read",
    }),
    defineMethod({
        name: "set",
        params: recorderSetSchema,
        result: z.unknown(),
        resultName: "{ settings, audio, applied }",
        doc: RECORDER_SET_SETTINGS_DOC,
        effect: "reversible",
    }),
    defineMethod({
        name: "displays.list",
        params: z.object({}),
        result: z.unknown(),
        resultName: "Array<DisplayInfo & { recorded }>",
        doc: "Every display, and which are recorded.",
        effect: "read",
    }),
    defineMethod({
        name: "displays.add",
        params: z.object({ displayId: z.number().int() }),
        positional: ["displayId"],
        result: z.unknown(),
        resultName: "DisplaySelection",
        doc: "Records one more display.",
        effect: "reversible",
    }),
    defineMethod({
        name: "displays.remove",
        params: z.object({ displayId: z.number().int() }),
        positional: ["displayId"],
        result: z.unknown(),
        resultName: "DisplaySelection",
        doc: "Stops recording a display.",
        effect: "reversible",
    }),
    defineMethod({
        name: "displays.switch",
        params: z.object({ displayId: z.number().int() }),
        positional: ["displayId"],
        result: z.unknown(),
        resultName: "DisplaySelection",
        doc: "Records only this display from now on.",
        effect: "reversible",
    }),
    defineMethod({
        name: "displays.mode",
        params: z.object({ mode: displayModeSchema }),
        positional: ["mode"],
        result: z.unknown(),
        resultName: "DisplaySelection",
        doc: "all, main, follow-focus or a screen index.",
        effect: "reversible",
    }),
    defineMethod({
        name: "audio.list",
        params: z.object({}),
        result: z.unknown(),
        resultName: "{ inputs, outputs }",
        doc: "The audio devices, with the ids audio.setInput takes.",
        effect: "read",
    }),
    defineMethod({
        name: "audio.mute",
        params: z.object({ source: z.enum(AUDIO_SOURCES) }),
        positional: ["source"],
        result: z.unknown(),
        resultName: "AudioState",
        doc: "Mutes mic or system; the track keeps its length.",
        effect: "reversible",
    }),
    defineMethod({
        name: "audio.unmute",
        params: z.object({ source: z.enum(AUDIO_SOURCES) }),
        positional: ["source"],
        result: z.unknown(),
        resultName: "AudioState",
        doc: "Unmutes mic or system.",
        effect: "reversible",
    }),
    defineMethod({
        name: "audio.setInput",
        params: z.object({ deviceId: z.string() }),
        positional: ["deviceId"],
        result: z.unknown(),
        resultName: "AudioState",
        doc: "Records the microphone from this device.",
        effect: "reversible",
    }),
    defineMethod({
        name: "mark",
        params: z.object({ label: z.string().min(1).max(80) }),
        positional: ["label"],
        result: z.custom<RecordingMarker>(),
        resultName: "{ atMs, label }",
        doc: 'Marks this moment with a label ("login done") at its time in the movie; the editor lists it on the timeline and movie.markers() returns it.',
        effect: "reversible",
    }),
    defineMethod({
        name: "jobs",
        params: z.object({}),
        result: z.custom<JobInfo[]>(),
        resultName: "JobInfo[]",
        doc: "The post-processing jobs with their latest progress.",
        effect: "read",
    }),
    defineMethod({
        name: "on",
        params: z.object({ event: z.enum([...EVENTS, "*"]), callback: z.custom<(params: unknown) => void>() }),
        positional: ["event", "callback"],
        result: z.unknown(),
        resultName: "() => void",
        doc: "Calls back on each event; returns the unsubscribe function.",
        effect: "read",
    }),
    defineMethod({
        name: "waitFor",
        params: z.object({
            predicate: z.custom<(status: RecorderStatus) => boolean>(),
            options: z.object({ timeoutMs: z.number() }).optional(),
        }),
        positional: ["predicate", "options"],
        result: statusSchema,
        resultName: "RecorderStatus",
        doc: "Resolves with the status once predicate(status) is true (checked on each event and every second); rejects after timeoutMs (default 60000).",
        effect: "read",
    }),
];

export const recorderApi = defineApi({
    id: "recorder",
    global: "recorder",
    title: "Screen recorder",
    summary: "Start, attach to and control screen recordings over the live recording socket.",
    methods: [
        defineMethod({
            name: "start",
            params: recorderStartSchema,
            result: z.unknown(),
            resultName: "Recording",
            doc: 'Starts a library recording (frames of the chosen displays, sound when asked) and returns its handle. Frames default to the recorder\'s files moved at the stop; frames: { format: "jpeg", naming: "wall-clock", flush: "piece" } with ocr: { enabled: true } and ocrSink: "jsonl" records the way a meeting does (each piece\'s JPEGs and ocr.jsonl rows exist while it records).',
            effect: "reversible",
        }),
        defineMethod({
            name: "list",
            params: z.object({}),
            result: z.unknown(),
            resultName: "Array<{ id, kind, title, state, displays, frames }>",
            doc: "The running recordings of every recorder (meetings, control sessions, library).",
            effect: "read",
        }),
        defineMethod({
            name: "attach",
            params: z.object({ id: z.string() }),
            positional: ["id"],
            result: z.unknown(),
            resultName: "Recording",
            doc: "A handle on a running recording by id.",
            effect: "read",
        }),
    ],
    handles: [
        {
            name: "Recording",
            summary: "One running recording; recordingId and folder name its result for editor.open.",
            methods: recordingMethods,
        },
    ],
    notes: ["A method the recorder kind does not offer throws an error that names the methods it has."],
});

/** One running recording, the same for every recorder kind: a RecorderClient on its socket. */
export class RecordingHandle {
    readonly displays = {
        list: () => this.check("displays.list", () => this.client.listDisplays()),
        add: (displayId: number) => this.check("displays.add", () => this.client.addDisplay(displayId)),
        remove: (displayId: number) => this.check("displays.remove", () => this.client.removeDisplay(displayId)),
        switch: (displayId: number) => this.check("displays.switch", () => this.client.switchDisplay(displayId)),
        mode: (mode: z.infer<typeof displayModeSchema>) =>
            this.check("displays.mode", () => this.client.setDisplayMode(mode)),
    };
    readonly audio = {
        list: () => this.check("audio.list", () => this.client.listAudioDevices()),
        mute: (source: AudioSource) => this.check("audio.mute", () => this.client.muteAudio(source, true)),
        unmute: (source: AudioSource) => this.check("audio.mute", () => this.client.muteAudio(source, false)),
        setInput: (deviceId: string) => this.check("audio.setInput", () => this.client.setAudioInput(deviceId)),
    };
    private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
    private subscribed?: Promise<void>;

    constructor(
        readonly client: RecorderClient,
        private readonly owned?: LibraryRecording
    ) {}

    get id(): string {
        return this.client.entry.id;
    }

    get recordingId(): string {
        if (!this.owned && this.kind === "meeting") {
            return this.client.entry.folder
                ? basename(this.client.entry.folder)
                : this.client.entry.id.replace(/^meeting-/, "");
        }
        return this.owned?.id ?? this.client.entry.id;
    }

    get kind(): string {
        return this.client.kind;
    }

    get folder(): string | undefined {
        const folder = this.owned?.folder ?? this.client.entry.folder;
        return !this.owned && this.kind === "meeting" && folder ? join(folder, "frames") : folder;
    }

    /** A clear error for a method this recorder kind does not serve, before the call and after an RPC refusal. */
    private async check<T>(method: RecorderMethod, call: () => Promise<T>): Promise<T> {
        const offered = () => `it offers ${this.client.methods.join(", ")}`;

        if (!this.client.methods.includes(method)) {
            throw new Error(`The ${this.kind} recording "${this.id}" has no ${method} (yet); ${offered()}`);
        }

        try {
            return await call();
        } catch (error) {
            if (
                error instanceof RpcError &&
                (error.code === RPC_ERRORS.methodNotFound || error.code === RPC_ERRORS.unsupported)
            ) {
                throw new Error(
                    `The ${this.kind} recording "${this.id}" cannot ${method}: ${error.message}; ${offered()}`
                );
            }

            throw error;
        }
    }

    status(): Promise<RecorderStatus> {
        return this.check("status", () => this.client.status());
    }

    pause() {
        return this.check("pause", () => this.client.pause());
    }

    resume() {
        return this.check("resume", () => this.client.resume());
    }

    async stop(options: { wait?: boolean } = {}): Promise<StopAnswer & { recordingId: string; folder?: string }> {
        const answer = await this.check("stop", () => this.client.stop(options));
        return { ...answer, recordingId: this.recordingId, folder: this.folder };
    }

    discard() {
        return this.check("discard", () => this.client.discard());
    }

    mark(label: string): Promise<RecordingMarker> {
        return this.check("marker.add", () => this.client.addMarker(label));
    }

    settings() {
        return this.check("settings.get", () => this.client.getSettings());
    }

    set(patch: z.input<typeof recorderSetSchema>) {
        const parsed = settingsPatchOf(patch);
        return this.check("settings.set", () => this.client.setSettings(parsed));
    }

    jobs(): Promise<JobInfo[]> {
        return this.check("jobs.list", () => this.client.listJobs());
    }

    private ensureSubscribed(): Promise<void> {
        this.subscribed ??= this.client.subscribe((notification: LiveNotification) => {
            for (const listener of this.listeners.get(notification.event) ?? []) {
                listener(notification.params);
            }

            for (const listener of this.listeners.get("*") ?? []) {
                listener(notification);
            }
        });
        return this.subscribed;
    }

    /** Calls back on each `event` notification (`*` for all); returns the unsubscribe function. */
    on(event: (typeof EVENTS)[number] | "*", callback: (params: unknown) => void): () => void {
        const set = this.listeners.get(event) ?? new Set();
        set.add(callback);
        this.listeners.set(event, set);
        void this.ensureSubscribed().catch((error: unknown) => {
            set.delete(callback);
            this.subscribed = undefined;
            log.warn({ error, id: this.id }, "recording event subscription failed");
        });
        return () => {
            set.delete(callback);
        };
    }

    async waitFor(
        predicate: (status: RecorderStatus) => boolean,
        options: { timeoutMs?: number } = {}
    ): Promise<RecorderStatus> {
        const timeoutMs = options.timeoutMs ?? 60_000;
        const deadline = Date.now() + timeoutMs;
        const remaining = () => Math.max(0, deadline - Date.now());
        const expired = () => new Error(`waitFor: the condition did not hold within ${timeoutMs} ms`);
        let wake: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const off = this.on("*", () => wake?.());

        try {
            // The subscription and each status read have the RPC's own, longer timeout: they get what is left of this one.
            await withTimeout(this.ensureSubscribed(), remaining(), expired());
            while (remaining() > 0) {
                const status = await withTimeout(this.status(), remaining(), expired());

                if (predicate(status)) {
                    return status;
                }

                await new Promise<void>((resolve) => {
                    wake = resolve;
                    timer = setTimeout(resolve, Math.min(1000, remaining()));
                });
                clearTimeout(timer);
            }
        } finally {
            clearTimeout(timer);
            off();
        }

        throw expired();
    }

    close(): void {
        this.client.close();
    }
}

/** The REPL's `recorder` global. The frame recorder comes from the host, which knows how to build ax-tool. */
export class RecorderToolset extends ReplToolset {
    readonly api = recorderApi;
    private readonly owned: LibraryRecording[] = [];
    private readonly handles: RecordingHandle[] = [];

    constructor(private readonly createRecorder: () => FrameRecorder) {
        super();
    }

    async bootstrap(ctx: ToolsetContext): Promise<Record<string, unknown>> {
        const recorder = {
            start: async (input: z.input<typeof recorderStartSchema> = {}) => {
                const options = recorderStartSchema.parse(input);
                if (ctx.recorder) {
                    const id = await ctx.recorder.start(options);
                    return this.track(new RecordingHandle(await RecorderClient.connect(id)));
                }

                const recording = await startRecording({
                    recorder: this.createRecorder(),
                    ...libraryStartOptions(options),
                });
                this.owned.push(recording);
                return this.track(new RecordingHandle(await RecorderClient.connect(recording.id), recording));
            },
            list: async () =>
                listLiveRecordings().map(({ id, kind, title, state, displays, frames }) => ({
                    id,
                    kind,
                    title,
                    state,
                    displays,
                    frames,
                })),
            attach: async (id: string) => this.track(new RecordingHandle(await RecorderClient.connect(id))),
        };
        return { recorder };
    }

    private track(handle: RecordingHandle): RecordingHandle {
        this.handles.push(handle);
        return handle;
    }

    /** Stops the recordings this worker started (their post-processing included) and closes every connection. */
    override async dispose(): Promise<void> {
        for (const recording of this.owned.splice(0)) {
            try {
                await recording.stop();
            } catch (error) {
                log.warn({ error, id: recording.id }, "a REPL recording did not stop cleanly");
            }
        }

        for (const handle of this.handles.splice(0)) {
            handle.close();
        }
    }
}
