import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cursorTrackPath, ffmpegSegmentJoiner, nativeSegmentRecorder } from "@app/control/lib/recording-native";
import { RecordingSession, type RecordingSessionEvent } from "@app/control/lib/recording-session";
import { SessionRecorderControl } from "@app/control/lib/recording-session-control";
import { describeRecordingTarget, type RecordingTarget } from "@app/control/lib/recording-targets";
import { ensureBinaryAsync } from "@app/control/lib/runner";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { passStartGate, releaseStartGate } from "@genesiscz/utils/process/start-gate";
import {
    RECORDING_MANIFEST,
    type RecordingManifest,
    recordingsLibraryDir,
} from "@genesiscz/utils/screen-recorder/library";
import { LiveRecordingServer, liveRecordingId } from "@genesiscz/utils/screen-recorder/live";
import { CAMERA_MOVIE } from "./library";

const { log } = logger.scoped("recorder-video");

/** The longest video recording `tools recorder start` takes: four hours, in 180 s segments. */
export const VIDEO_RECORDING_MAX_SECONDS = 4 * 60 * 60;

export interface VideoRecordingOptions {
    target: RecordingTarget;
    title?: string;
    fps?: number;
    /** Frames per second while nothing moves (0.1–5); by default the movie keeps `fps`. */
    idleFps?: number;
    /** The share of the picture, in percent, that must change before the stream leaves the idle rate. */
    threshold?: number;
    /** CG window ids no movie may show (the camera bubble's preview, a host's own panel). */
    excludeWindowIds?: number[];
    /** The recorder face records the camera beside the screen into `camera.mov` (`settings.camera` asks for it). */
    camera?: boolean;
    audio?: ("system" | "mic")[];
    micDevice?: string;
    /** Keep the system cursor in the movie; by default it stays out and the editor draws it from the track. */
    systemCursor?: boolean;
    /** False keeps the shortcuts out of the cursor track; by default the ⌘/⌃ presses are kept for the keys overlay. */
    shortcuts?: boolean;
    maxSeconds?: number;
    /** The red border around what is recorded (never in the movie). */
    indicator?: boolean;
    /** The menu bar host opens the floating controls. */
    panel?: boolean;
    emit?: (event: RecordingSessionEvent) => void;
    /**
     * The start gate of a caller that waits for this recording and may give up (`movies.record`): passed right before
     * anything is made, after the slow part, so a recording that comes after the caller gave up never starts.
     */
    startGate?: string;
    /** The slow part before the gate; default ax-tool's build, which a fresh checkout does first. */
    prepare?: () => Promise<unknown>;
}

/** The caller that started this recording gave up waiting before it could start (its start gate was closed). */
export class RecordingStartCancelled extends Error {
    constructor() {
        super("not recording: the caller that started this recording gave up waiting for it");
        this.name = "RecordingStartCancelled";
    }
}

export interface VideoRecordingResult {
    outcome: "done" | "discarded" | "failed";
    id: string;
    folder: string;
    movie?: string;
    cursorTrack?: string;
    durationMs?: number;
    warnings: string[];
}

function stamp(date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

async function writeManifest(folder: string, manifest: RecordingManifest): Promise<void> {
    const path = join(folder, RECORDING_MANIFEST);
    const partial = `${path}.partial`;
    await writeFile(partial, `${SafeJSON.stringify(manifest, null, 2)}\n`);
    await rename(partial, path);
}

/**
 * Records the screen (or a window or app) as a movie into the recordings library: `screen.mp4` with its audio
 * tracks, `cursor.jsonl` and `recording.json`, ready for the editor. The recording is a live entry, so the menu bar
 * item, the floating controls, `tools recorder stop` and the REPL all control it. Pausing ends a segment, so the
 * paused time is not in the movie. Ctrl-C or SIGTERM keeps what was recorded.
 */
export async function recordVideo(options: VideoRecordingOptions): Promise<VideoRecordingResult> {
    const gate = options.startGate;

    if (!gate) {
        return recordPassed(options);
    }

    await (options.prepare ?? ensureBinaryAsync)();

    if ((await passStartGate(gate)).status === "cancelled") {
        log.warn({ gate }, "the caller gave up waiting before the recording could start; not recording");
        throw new RecordingStartCancelled();
    }

    try {
        return await recordPassed(options);
    } finally {
        releaseStartGate(gate);
    }
}

async function recordPassed(options: VideoRecordingOptions): Promise<VideoRecordingResult> {
    const id = `video-${stamp()}`;
    const folder = recordingsLibraryDir(id);
    const movie = join(folder, "screen.mp4");
    // "display 0" (the target's own description) said nothing in the library; a time does.
    const started = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const title =
        options.title?.trim() ||
        (options.target.kind === "display"
            ? `Screen recording ${pad(started.getHours())}:${pad(started.getMinutes())}`
            : describeRecordingTarget(options.target));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const manifest: RecordingManifest = {
        version: 1,
        id,
        title,
        startedAt: new Date().toISOString(),
        displays: [],
        settings: {
            kind: "video",
            target: options.target,
            fps: options.fps ?? 60,
            ...(options.idleFps === undefined ? {} : { idleFps: options.idleFps }),
            ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
            ...(options.camera ? { camera: { requested: true, file: CAMERA_MOVIE } } : {}),
            audio: { sources: options.audio ?? [], micDevice: options.micDevice },
            cursor: options.systemCursor ? "system" : "drawn",
            shortcuts: options.shortcuts !== false,
        },
        frames: [],
        warnings: [],
    };
    await writeManifest(folder, manifest);
    log.info(
        { id, folder, target: options.target, audio: options.audio, fps: options.fps },
        "video recording starting"
    );

    const warnings: string[] = [];
    let durationMs: number | undefined;
    let live: LiveRecordingServer | undefined;
    let control: SessionRecorderControl | undefined;
    const emit = (event: RecordingSessionEvent) => {
        log.info({ event }, "recording event");
        control?.observe(event);

        if (event.event === "state" || event.event === "error") {
            void control?.status().then((status) => live?.update({ state: status.state, warning: status.warning }));
        }

        if (event.event === "error") {
            warnings.push(event.message);
        }

        if (event.event === "done") {
            durationMs = event.durationMs;
        }

        // A session pauses at its limit and waits for its host to decide; this recording's limit is the stop.
        if (event.event === "state" && event.state === "paused" && event.reason === "limit") {
            void control?.stop({ wait: false }).catch((error: unknown) => {
                log.debug({ error }, "the recording was stopping already");
            });
        }

        options.emit?.(event);
    };
    const session = new RecordingSession({
        target: options.target,
        directory: join(folder, `segments-${randomUUID().slice(0, 8)}`),
        output: movie,
        recorder: nativeSegmentRecorder({
            fps: options.fps,
            idleFps: options.idleFps,
            threshold: options.threshold,
            excludeWindowIds: options.excludeWindowIds,
            indicator: options.indicator,
            audio: options.audio,
            micDevice: options.micDevice,
            cursorTrack: true,
            cursorShapes: options.systemCursor ? undefined : join(folder, "cursor-shapes"),
            shortcuts: options.shortcuts !== false,
        }),
        join: ffmpegSegmentJoiner,
        emit,
        maxSeconds: options.maxSeconds ?? VIDEO_RECORDING_MAX_SECONDS,
    });
    control = new SessionRecorderControl(session, {
        target: options.target,
        title,
        onProgress: (event) => live?.emit("progress", { ...event }),
    });
    live = new LiveRecordingServer({
        id: liveRecordingId("recorder", `${process.pid}-${randomUUID().slice(0, 8)}`),
        kind: control.kind,
        title,
        folder,
        control,
        panel: options.panel,
    });
    const activeLive = live;
    const activeControl = control;

    let outcome: VideoRecordingResult["outcome"];
    try {
        outcome = await withInterrupt(
            async (signal) => {
                signal.addEventListener(
                    "abort",
                    () =>
                        void activeControl.stop({ wait: false }).catch((error: unknown) => {
                            log.debug({ error }, "the recording was stopping already");
                        }),
                    { once: true }
                );
                await session.start();
                return session.finished;
            },
            { handleTermination: true }
        );
    } finally {
        activeLive.close();
    }

    const joinedCursor = cursorTrackPath(movie);
    const cursorTrack = join(folder, "cursor.jsonl");

    if (existsSync(joinedCursor)) {
        await rename(joinedCursor, cursorTrack);
    }

    await writeManifest(folder, {
        ...manifest,
        endedAt: new Date().toISOString(),
        settings: {
            ...manifest.settings,
            video: existsSync(movie) ? { file: "screen.mp4", durationMs } : undefined,
            outcome,
            markers: activeControl.markers,
        },
        warnings,
    });
    log.info({ id, outcome, durationMs, warnings: warnings.length }, "video recording ended");
    return {
        outcome,
        id,
        folder,
        movie: existsSync(movie) ? movie : undefined,
        cursorTrack: existsSync(cursorTrack) ? cursorTrack : undefined,
        durationMs,
        warnings,
    };
}
