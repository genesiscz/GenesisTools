import { type JobInfo, JobRegistry, type ProgressEvent } from "@genesiscz/utils/jobs";
import { logger } from "@genesiscz/utils/logger";
import {
    type AudioSource,
    type RecorderState as ControlState,
    type DisplayEntry,
    type DisplaySelection,
    RecorderControl,
    type RecorderMethod,
    type RecorderSettings,
    type RecorderSettingsPatch,
    type RecorderStatus,
    type RecordingMarker,
    RPC_ERRORS,
    RpcError,
    refuseMarker,
    type SettingsAnswer,
    type StopAnswer,
} from "@genesiscz/utils/screen-recorder/control";
import { parseDisplayList } from "@genesiscz/utils/screen-recorder/displays";
import type { RecordingCommand, RecordingSession, RecordingSessionEvent, RecordingState } from "./recording-session";
import { describeRecordingTarget, type RecordingTarget, recordingTargetSchema } from "./recording-targets";
import { type AxResult, runAxAsync } from "./runner";

const { log } = logger.scoped("control-recording-session-control");

const SCREENS_TIMEOUT_MS = 5_000;

const SESSION_METHODS: readonly RecorderMethod[] = [
    "status",
    "pause",
    "resume",
    "stop",
    "discard",
    "restart",
    "target.switch",
    "displays.list",
    "displays.switch",
    "jobs.list",
    "marker.add",
];

/** The settings keys a movie keeps as they are, and why; `settings.set` refuses them by name. */
type MovieFixedKey = "maxLongSide" | "heartbeatSec" | "ocr";

const MOVIE_FIXED: Record<MovieFixedKey, string> = {
    maxLongSide: "a movie keeps the full size of what it records",
    heartbeatSec: "a movie has no heartbeat: its rates decide every frame",
    ocr: "a movie reads no text",
};

const MOVIE_FIXED_KEYS: readonly MovieFixedKey[] = ["maxLongSide", "heartbeatSec", "ocr"];

/** What a movie answers for the keys it keeps: no size cap below the largest, no heartbeat, no OCR. */
const MOVIE_FIXED_SETTINGS: Pick<RecorderSettings, MovieFixedKey> = {
    maxLongSide: 16_384,
    heartbeatSec: 0,
    ocr: { enabled: false, languages: ["en-US"], minChars: 0 },
};

const CONTROL_STATE: Record<RecordingState, ControlState> = {
    starting: "recording",
    recording: "recording",
    paused: "paused",
    finishing: "stopping",
};

/**
 * `tools control capture session` as a RecorderControl: pause, resume, stop, discard, restart and a target switch (a
 * window, an app or a display), served over the live recording socket and its stdin alike. The movie join after the
 * stop runs as a job.
 */
export class SessionRecorderControl extends RecorderControl {
    readonly kind = "control-session";
    /** The session's methods, and `settings.get`/`settings.set` when the session has movie rates. */
    readonly methods: readonly RecorderMethod[];
    /** The moments marked while it records, at their movie time. */
    readonly markers: RecordingMarker[] = [];
    private state: ControlState = "recording";
    private target: RecordingTarget;
    private warning?: string;
    private elapsedMs = 0;
    private limitMs?: number;
    private segments = 0;
    private readonly jobs: JobRegistry;
    private finishJob?: string;

    constructor(
        private readonly session: RecordingSession,
        options: {
            target: RecordingTarget;
            title?: string;
            onProgress?: (event: ProgressEvent) => void;
            screens?: () => Promise<AxResult>;
            /** The movie's sound, for `settings.get`; a movie mutes nothing. */
            audio?: { sources: AudioSource[]; micDevice?: string };
        }
    ) {
        super();
        this.methods = session.currentRates() ? [...SESSION_METHODS, "settings.get", "settings.set"] : SESSION_METHODS;
        this.audio = options.audio ?? { sources: [] };
        this.target = options.target;
        this.title = options.title ?? describeRecordingTarget(options.target);
        this.jobs = new JobRegistry(options.onProgress);
        this.screens = options.screens ?? (() => runAxAsync({ args: ["screens"], timeoutMs: SCREENS_TIMEOUT_MS }));
    }

    private readonly title: string;
    private readonly screens: () => Promise<AxResult>;
    private readonly audio: { sources: AudioSource[]; micDevice?: string };

    /** The movie's rates and threshold, and the keys it keeps as they are (`fixed`, with why). */
    override async getSettings(): Promise<SettingsAnswer> {
        const rates = this.session.currentRates();

        if (!rates) {
            return super.getSettings();
        }

        return {
            settings: { ...rates, ...MOVIE_FIXED_SETTINGS },
            audio: {
                sources: this.audio.sources,
                muted: { mic: false, system: false },
                ...(this.audio.micDevice ? { micDevice: this.audio.micDevice } : {}),
            },
            fixed: MOVIE_FIXED,
        };
    }

    /** Changes the movie's rates and threshold (`activeFps`, `idleFps`, `threshold`); the next segment records with them. */
    override async setSettings(patch: RecorderSettingsPatch): Promise<SettingsAnswer> {
        const rates = this.session.currentRates();

        if (!rates) {
            return super.setSettings(patch);
        }

        const kept = MOVIE_FIXED_KEYS.filter((key) => patch[key] !== undefined);

        if (kept.length > 0) {
            throw new RpcError(
                RPC_ERRORS.unsupported,
                `a movie recording keeps ${kept.join(", ")} as they are (${kept.map((key) => MOVIE_FIXED[key]).join("; ")}); it changes activeFps, idleFps and threshold`
            );
        }

        const activeFps = patch.activeFps ?? rates.activeFps;
        // ax-tool never records the idle rate above the active one (Record.swift setFrameRates).
        const idleFps = Math.min(patch.idleFps ?? rates.idleFps, activeFps);
        const applied = await this.session.retune({
            activeFps,
            idleFps,
            threshold: patch.threshold ?? rates.threshold,
        });
        return { ...(await this.getSettings()), applied };
    }

    /** Every session event passes here, so the state and target stay what the session says. */
    observe(event: RecordingSessionEvent): void {
        if (event.event === "state") {
            this.state = CONTROL_STATE[event.state];
            this.target = event.target;
            this.elapsedMs = event.elapsedMs;
            this.limitMs = event.limitMs;
            this.segments = event.segments;
        } else if (event.event === "elapsed") {
            this.elapsedMs = event.elapsedMs;
            this.limitMs = event.limitMs;
        } else if (event.event === "segment") {
            this.segments = Math.max(this.segments, event.index);
        } else if (event.event === "error") {
            this.warning = event.message;
        }
    }

    async status(): Promise<RecorderStatus> {
        return {
            kind: this.kind,
            title: this.title,
            state: this.state,
            displays: [],
            frames: 0,
            elapsedMs: this.elapsedMs,
            segments: this.segments,
            ...(this.limitMs === undefined ? {} : { limitMs: this.limitMs }),
            ...(this.warning ? { warning: this.warning } : {}),
        };
    }

    async addMarker(label: string): Promise<RecordingMarker> {
        if (this.state !== "recording") {
            refuseMarker(this.state);
        }

        const marker = { atMs: Math.round(this.session.elapsedMs()), label };
        this.markers.push(marker);
        log.debug({ marker }, "recording marker added");
        return marker;
    }

    async pause(): Promise<{ state: ControlState }> {
        if (this.state !== "recording") {
            throw new RpcError(RPC_ERRORS.alreadyPaused, `the recording is ${this.state}`);
        }

        await this.session.command({ cmd: "pause" });
        return { state: this.state };
    }

    async resume(): Promise<{ state: ControlState }> {
        if (this.state !== "paused") {
            throw new RpcError(RPC_ERRORS.notPaused, "the recording is not paused");
        }

        await this.session.command({ cmd: "resume" });
        return { state: this.state };
    }

    async stop(options: { wait?: boolean } = {}): Promise<StopAnswer> {
        if (this.finishJob) {
            throw new RpcError(RPC_ERRORS.alreadyStopped, "the recording is already stopping");
        }

        const job = this.jobs.task<string>("join", async (ctx) => {
            ctx.progress({ done: 0, total: 1, unit: "steps", message: "joining the segments" });

            // A save that failed leaves the session paused with a warning; the stop fails and can be sent again.
            try {
                await this.session.command({ cmd: "stop" });

                if (this.state === "paused") {
                    throw new Error(this.warning ?? "The recording could not be saved; stop can be retried.");
                }
            } catch (error) {
                this.finishJob = undefined;
                throw error;
            }

            const outcome = await this.session.finished;
            ctx.progress({ done: 1, total: 1, unit: "steps", message: outcome });
            return outcome;
        });
        this.finishJob = job.id;

        if (options.wait === false) {
            return { state: "stopping", job: job.id };
        }

        const { state: outcome } = await job.done;
        return { state: "stopped", job: job.id, ...(outcome ? { outcome } : {}) };
    }

    override async discard(): Promise<StopAnswer> {
        await this.session.command({ cmd: "discard" });
        return { state: "stopped", outcome: await this.session.finished };
    }

    override async restart(): Promise<{ state: ControlState }> {
        await this.session.command({ cmd: "restart" });
        return { state: this.state };
    }

    override async switchTarget(target: unknown): Promise<{ state: ControlState }> {
        const parsed = recordingTargetSchema.safeParse(target);

        if (!parsed.success) {
            throw new RpcError(RPC_ERRORS.invalidParams, "give a target: a window, an app or a display");
        }

        await this.session.command({ cmd: "switch", target: parsed.data });
        return { state: this.state };
    }

    override async listDisplays(): Promise<DisplayEntry[]> {
        const target = this.target;
        return (await this.connectedDisplays()).map((display) => ({
            ...display,
            recorded: target.kind === "display" && target.screenIndex === display.index,
        }));
    }

    override async switchDisplay(displayId: number): Promise<DisplaySelection> {
        const display = (await this.connectedDisplays()).find((one) => one.id === displayId);

        if (!display) {
            throw new RpcError(RPC_ERRORS.unknownDisplay, `display ${displayId} is not connected`);
        }

        await this.session.command({
            cmd: "switch",
            target: { kind: "display", screenIndex: display.index, name: display.name },
        });
        return { mode: display.index, chosen: [display.id], applied: "restart" };
    }

    override async listJobs(): Promise<JobInfo[]> {
        return this.jobs.list();
    }

    private async connectedDisplays() {
        const result = await this.screens();

        if (!result.ok) {
            throw new RpcError(
                RPC_ERRORS.internal,
                `Cannot list displays: ${result.error ?? "ax-tool screens failed"}`
            );
        }

        return parseDisplayList(result);
    }
}

/** The last queued command of each control; the next one starts when it has settled. */
const commandQueues = new WeakMap<RecorderControl, Promise<void>>();

/**
 * One stdin command of the session, as the same RecorderControl call the socket makes, queued behind the commands
 * before it: a pause and a resume sent together each check the state the one before left.
 */
export function applyRecordingCommand(control: RecorderControl, command: RecordingCommand): Promise<void> {
    const next = (commandQueues.get(control) ?? Promise.resolve()).then(() =>
        dispatchRecordingCommand(control, command)
    );
    commandQueues.set(
        control,
        next.catch((error: unknown) => {
            log.debug({ error }, "queued recording command refused");
        })
    );
    return next;
}

async function dispatchRecordingCommand(control: RecorderControl, command: RecordingCommand): Promise<void> {
    log.debug({ command: command.cmd }, "session command through its RecorderControl");

    switch (command.cmd) {
        case "pause":
            await control.pause();
            return;
        case "resume":
            await control.resume();
            return;
        case "stop":
            await control.stop({ wait: false });
            return;
        case "discard":
            await control.discard();
            return;
        case "restart":
            await control.restart();
            return;
        case "switch":
            await control.switchTarget(command.target);
            return;
    }
}
