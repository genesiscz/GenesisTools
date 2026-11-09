import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { type CountdownHold, runCountdown } from "@app/control/lib/peekaboo";
import {
    audioTrackTitles,
    cursorTrackPath,
    movieLengthMs,
    type NativeRecorderOptions,
    nativeSegmentRecorder,
    SESSION_MOTION_THRESHOLD,
    segmentJoiner,
    titleAudioTracks,
} from "@app/control/lib/recording-native";
import { RecordingSession, type RecordingSessionEvent } from "@app/control/lib/recording-session";
import { SessionRecorderControl } from "@app/control/lib/recording-session-control";
import { describeRecordingTarget, type RecordingTarget } from "@app/control/lib/recording-targets";
import { ensureBinaryAsync } from "@app/control/lib/runner";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { formatCount } from "@genesiscz/utils/format";
import type { FlockState } from "@genesiscz/utils/fs/flock";
import { logger } from "@genesiscz/utils/logger";
import { passStartGate, releaseStartGate } from "@genesiscz/utils/process/start-gate";
import { alignCameraMovie, type CameraAlignment } from "@genesiscz/utils/recording-editor/camera";
import {
    newVideoRecordingId,
    RECORDING_MANIFEST,
    type RecordingManifest,
    type RecordingSpan,
    recordingsLibraryDir,
    writeRecordingManifest,
} from "@genesiscz/utils/screen-recorder/library";
import { LiveRecordingServer, liveRecordingId } from "@genesiscz/utils/screen-recorder/live";
import { trashRecordingFolder } from "@genesiscz/utils/screen-recorder/start";
import {
    type CameraHost,
    cameraRefusal,
    missingCameraWarning,
    recorderFaceState,
    startRecordingCamera,
    stopRecordingCamera,
} from "./camera-recorder";
import { CAMERA_MOVIE } from "./library";
import { DEFAULT_MOVIE_FPS, VIDEO_RECORDING_MAX_SECONDS } from "./start-options";

const { log } = logger.scoped("recorder-video");

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
    /**
     * The menu bar recorder records the camera beside the screen into `camera.mov` (`settings.camera` asks for it):
     * refused while it does not run, and a warning at the end when no camera movie came.
     */
    camera?: boolean;
    /** Whether the menu bar recorder runs; default its lock (`recorderFaceState`). */
    recorderFace?: () => FlockState;
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
    /** Called once the recording has its library folder and its live entry, before the first frame. */
    onStarted?: (recording: { id: string; folder: string; liveId: string }) => void;
    /**
     * The start gate of a caller that waits for this recording and may give up (`movies.record`): passed right before
     * anything is made, after the slow part, so a recording that comes after the caller gave up never starts.
     */
    startGate?: string;
    /** The slow part before the gate; default ax-tool's build, which a fresh checkout does first. */
    prepare?: () => Promise<unknown>;
    /**
     * Seconds counted down on screen before it records (after the slow part), as the capture picker does: the recorder
     * starts as the last second begins, and zero shows once the movie has its first frame.
     */
    countdownSeconds?: number;
    /** Shows the countdown; default an overlay near the pointer and a line a second on stderr. */
    countdown?: RecorderCountdown;
}

/** A countdown before a recording: it calls `hold.lastSecond` as its last second begins and holds zero for `hold.until`. */
export type RecorderCountdown = (seconds: number, hold: CountdownHold) => Promise<void>;

/**
 * A display or an area records the pointer beside the movie (the drawn cursor, clicks and the ⌘/⌃ shortcut rows). A
 * window or app movie is composed from those windows alone (ScreenCaptureKit's isolated capture), which has no pointer
 * and no audio to record.
 */
export function tracksPointer(target: RecordingTarget): boolean {
    return target.kind === "display" || target.kind === "region";
}

/** What each segment's native recorder records for this movie. */
export function segmentRecorderOptions(
    options: Omit<VideoRecordingOptions, "emit">,
    folder: string
): NativeRecorderOptions {
    const pointer = tracksPointer(options.target);
    return {
        fps: options.fps,
        idleFps: options.idleFps,
        threshold: options.threshold,
        excludeWindowIds: options.excludeWindowIds,
        indicator: options.indicator,
        audio: options.audio,
        micDevice: options.micDevice,
        cursorTrack: pointer,
        cursorShapes: pointer && !options.systemCursor ? join(folder, "cursor-shapes") : undefined,
        shortcuts: pointer && options.shortcuts !== false,
    };
}

/** The recorder's countdown: an overlay near the pointer and a line a second on stderr. */
export const showRecorderCountdown: RecorderCountdown = (seconds, hold) =>
    runCountdown(seconds, {
        text: { who: "recorder", line: "switch to what you record", overlay: "switch to what you record" },
        hold,
    });

/**
 * A countdown that first tells `announce` how long it runs: `start --json` prints it as a `countdown` event, so a
 * reader knows why nothing records yet (it saw nothing for those seconds, review 2026-11-07).
 */
export function announcedCountdown(
    announce: (seconds: number) => void,
    show: RecorderCountdown = showRecorderCountdown
): RecorderCountdown {
    return async (seconds, hold) => {
        announce(seconds);
        await show(seconds, hold);
    };
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
    /** Frames the movie holds and its average rate (ax-tool's capturedFrames over the movie's length). */
    frames?: number;
    averageFps?: number;
    warnings: string[];
    /** The start failed before it recorded anything, so its folder went to the GenesisTools trash. */
    removed?: boolean;
    /** The recording asked for the camera and no camera movie came: the CLI exits 1. */
    cameraMissing?: boolean;
}

/** The line `tools recorder start` prints at the end of a movie: the movie with its frames and rate, or why it failed. */
export function videoDoneLine(result: VideoRecordingResult): string {
    if (result.movie) {
        const rate =
            result.averageFps === undefined
                ? ""
                : ` (${formatCount(result.frames ?? 0, "frame")}, ${result.averageFps} fps)`;
        return `${result.outcome}: ${result.movie}${rate}`;
    }

    return result.removed
        ? `failed, nothing was recorded: ${result.warnings[0] ?? "the capture did not start"}`
        : `${result.outcome}: ${result.folder}`;
}

/**
 * A start that made nothing: the folder holds only its recording.json and empty folders. Kept, it would stay in the
 * library as a card with no movie and no reason.
 */
export async function recordedNothing(folder: string): Promise<boolean> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.isFile() && entry.name === RECORDING_MANIFEST) {
            continue;
        }

        if (entry.isDirectory() && (await readdir(join(folder, entry.name))).length === 0) {
            continue;
        }

        return false;
    }

    return true;
}

/** What went wrong with a recording's camera movie at its end. */
export interface CameraEndProblem {
    /** `camera-missing`: no camera.json came; `camera-unaligned`: the movie could not be cut to the screen's spans. */
    code: "camera-missing" | "camera-unaligned";
    message: string;
}

/**
 * Ends the camera of a recording that started it. The face stops and writes camera.json; a kept recording then gets
 * its camera movie lined up with the screen's spans (`alignCameraMovie`), so the bubble keeps the voice's time through
 * every pause and rollover. Returns what went wrong, or undefined.
 */
export async function endRecordingCamera({
    folder,
    outcome,
    spans,
    host,
    align = alignCameraMovie,
    finishWaitMs,
}: {
    folder: string;
    outcome: VideoRecordingResult["outcome"];
    spans: RecordingSpan[];
    host?: CameraHost;
    align?: (input: { folder: string; spans: RecordingSpan[] }) => Promise<CameraAlignment>;
    /** How long to wait for camera.json; default `CAMERA_FINISH_WAIT_MS`. */
    finishWaitMs?: number;
}): Promise<CameraEndProblem | undefined> {
    await stopRecordingCamera(folder, host);

    if (outcome === "discarded") {
        return undefined;
    }

    // The face finishes the camera movie once the live entry is gone; a recording that asked for it and got none says
    // so, in the manifest and in the result, instead of a movie that quietly has no camera.
    const missing = await missingCameraWarning({ folder, timeoutMs: finishWaitMs });

    if (missing) {
        return { code: "camera-missing", message: missing };
    }

    if (outcome !== "done") {
        return undefined;
    }

    const aligned = await align({ folder, spans });
    log.info({ folder, spans: spans.length, result: aligned.result }, "the camera movie is lined up with the screen");
    return aligned.warning ? { code: "camera-unaligned", message: aligned.warning } : undefined;
}

/**
 * Records the screen (or a window or app) as a movie into the recordings library: `screen.mp4` with its audio
 * tracks, `cursor.jsonl` and `recording.json`, ready for the editor. The recording is a live entry, so the menu bar
 * item, the floating controls, `tools recorder stop` and the REPL all control it. Pausing ends a segment, so the
 * paused time is not in the movie. Ctrl-C or SIGTERM keeps what was recorded.
 */
export async function recordVideo(options: VideoRecordingOptions): Promise<VideoRecordingResult> {
    const gate = options.startGate;
    const countdownSeconds = options.countdownSeconds ?? 0;

    if (options.camera) {
        const face = (options.recorderFace ?? recorderFaceState)();
        const refusal = cameraRefusal(face);
        log.info({ face }, "the recording asks for the camera");

        if (refusal) {
            throw new Error(refusal);
        }
    }

    if (!gate && countdownSeconds === 0) {
        return recordPassed(options);
    }

    await (options.prepare ?? ensureBinaryAsync)();

    if (countdownSeconds === 0) {
        return recordThroughGate(options, gate);
    }

    // After the slow part, so the countdown is not stretched by a build. ax-tool takes about a second from its start
    // to the first frame, so the recording starts as the last second begins (the gate is passed then, so a caller that
    // gives up during the countdown still cancels the start), and the countdown holds zero until the first frame: the
    // first thing done after zero is in the movie. The overlay is kept out of the movie.
    const firstFrame = Promise.withResolvers<void>();
    let recording: Promise<VideoRecordingResult> | undefined;
    const start = (excludeWindowIds: number[] = []): Promise<VideoRecordingResult> => {
        if (recording) {
            return recording;
        }

        const excluded = [...(options.excludeWindowIds ?? []), ...excludeWindowIds];
        log.info({ excludeWindowIds: excluded }, "the countdown's last second began; starting the recorder");
        recording = recordThroughGate(
            {
                ...options,
                ...(excluded.length ? { excludeWindowIds: excluded } : {}),
                emit: (event) => {
                    if (endsCountdown(event)) {
                        firstFrame.resolve();
                    }

                    options.emit?.(event);
                },
            },
            gate
        );
        // A start that fails or is cancelled ends the countdown too; its error comes from the await below.
        recording.then(
            () => firstFrame.resolve(),
            () => firstFrame.resolve()
        );
        return recording;
    };

    log.info({ seconds: countdownSeconds }, "counting down before the recording");
    await (options.countdown ?? showRecorderCountdown)(countdownSeconds, {
        lastSecond: ({ excludeWindowIds }) => void start(excludeWindowIds),
        until: firstFrame.promise,
    });
    // A countdown that never said its last second began starts the recording at its end.
    return await start();
}

/** The session's first frame (or its end before one): a held countdown may show zero. */
function endsCountdown(event: RecordingSessionEvent): boolean {
    return (
        (event.event === "state" && event.state === "recording") ||
        (event.event === "error" && event.fatal) ||
        event.event === "done" ||
        event.event === "discarded"
    );
}

/** Records once the caller's start gate (when it has one) is passed, and releases the gate after. */
async function recordThroughGate(
    options: VideoRecordingOptions,
    gate: string | undefined
): Promise<VideoRecordingResult> {
    if (!gate) {
        return recordPassed(options);
    }

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
    const id = newVideoRecordingId();
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
    const fps = options.fps ?? DEFAULT_MOVIE_FPS;
    const manifest: RecordingManifest = {
        version: 1,
        id,
        title,
        startedAt: new Date().toISOString(),
        displays: [],
        settings: {
            kind: "video",
            target: options.target,
            fps,
            ...(options.idleFps === undefined ? {} : { idleFps: options.idleFps }),
            ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
            ...(options.camera ? { camera: { requested: true, file: CAMERA_MOVIE } } : {}),
            audio: { sources: options.audio ?? [], micDevice: options.micDevice },
            // "none": a window or app movie has no cursor track, so the editor draws no pointer and no shortcuts.
            cursor: tracksPointer(options.target) ? (options.systemCursor ? "system" : "drawn") : "none",
            shortcuts: tracksPointer(options.target) && options.shortcuts !== false,
        },
        frames: [],
        warnings: [],
    };
    await writeRecordingManifest(folder, manifest);
    log.info(
        { id, folder, target: options.target, audio: options.audio, fps: options.fps },
        "video recording starting"
    );

    const warnings: string[] = [];
    let durationMs: number | undefined;
    let segments = 0;
    let frameStats: { frames?: number; averageFps?: number } = {};
    let live: LiveRecordingServer | undefined;
    let control: SessionRecorderControl | undefined;
    const emit = (event: RecordingSessionEvent) => {
        // One per second while it records: the day log keeps them, the terminal shows the CLI's own state lines.
        log.debug({ event }, "recording event");
        control?.observe(event);

        // The live entry says "recording" while a segment arms too, so `lastFrameAt` (set at a segment's first frame and
        // with each elapsed second) is what tells a host that the movie records: the capture picker holds its
        // countdown for it.
        const framed =
            (event.event === "state" && event.state === "recording") || event.event === "elapsed"
                ? { lastFrameAt: new Date().toISOString() }
                : {};

        // Each state event re-anchors the floating controls' clock on the movie time; an error changes only the entry.
        if (event.event === "state") {
            void control?.status().then((status) => live?.notifyStatus(status, framed));
        } else if (event.event === "error") {
            void control?.status().then((status) => live?.update({ state: status.state, warning: status.warning }));
        } else if (event.event === "elapsed") {
            live?.update(framed);
        }

        if (event.event === "error") {
            warnings.push(event.message);
        }

        if (event.event === "done") {
            durationMs = event.durationMs;
            segments = event.segments;
            frameStats = {
                ...(event.frames === undefined ? {} : { frames: event.frames }),
                ...(event.averageFps === undefined ? {} : { averageFps: event.averageFps }),
            };
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
        recorder: nativeSegmentRecorder(segmentRecorderOptions(options, folder)),
        join: segmentJoiner(audioTrackTitles(options.audio)),
        measure: movieLengthMs,
        emit,
        maxSeconds: options.maxSeconds ?? VIDEO_RECORDING_MAX_SECONDS,
        // The rates `settings.set` changes while it records; a movie without an idle rate keeps its fps when still.
        rates: {
            activeFps: fps,
            idleFps: Math.min(options.idleFps ?? fps, fps),
            threshold: options.threshold ?? SESSION_MOTION_THRESHOLD,
        },
    });
    control = new SessionRecorderControl(session, {
        target: options.target,
        title,
        onProgress: (event) => live?.emit("progress", { ...event }),
        audio: { sources: options.audio ?? [], ...(options.micDevice ? { micDevice: options.micDevice } : {}) },
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
    options.onStarted?.({ id, folder, liveId: activeLive.id });

    let outcome: VideoRecordingResult["outcome"];
    let cameraRefused: string | undefined;
    let cameraStarted = false;
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

                // Asked for, not left to the face's watch of the live recordings; a refusal ends the start.
                if (options.camera) {
                    cameraRefused = await startRecordingCamera(folder);
                    cameraStarted = cameraRefused === undefined;

                    if (cameraRefused) {
                        emit({ event: "error", message: cameraRefused, code: "camera-refused", fatal: true });
                        await activeControl.discard();
                    }
                }

                return session.finished;
            },
            { handleTermination: true }
        );
    } finally {
        activeLive.close();
    }

    const spans = session.movieSpans();
    const cameraProblem = cameraStarted ? await endRecordingCamera({ folder, outcome, spans }) : undefined;

    // One segment is moved, not joined, so its tracks still read "Core Media Audio": title them by one stream copy.
    if (outcome === "done" && segments === 1 && options.audio?.length && existsSync(movie)) {
        await titleAudioTracks(movie, audioTrackTitles(options.audio)).catch((error: unknown) => {
            log.warn({ error, movie }, "the audio tracks keep their untitled names");
        });
    }

    if (cameraRefused) {
        outcome = "failed";
    }

    const joinedCursor = cursorTrackPath(movie);
    const cursorTrack = join(folder, "cursor.jsonl");

    if (existsSync(joinedCursor)) {
        await rename(joinedCursor, cursorTrack);
    }

    if (cameraProblem) {
        log.warn({ id, folder, code: cameraProblem.code }, "the recording's camera movie has a problem");
        warnings.push(cameraProblem.message);
        options.emit?.({ event: "error", message: cameraProblem.message, code: cameraProblem.code, fatal: false });
    }

    await writeRecordingManifest(folder, {
        ...manifest,
        endedAt: new Date().toISOString(),
        settings: {
            ...manifest.settings,
            // Each kept segment on the wall clock, for any clock that has to line up with this movie (the camera's).
            video: existsSync(movie)
                ? { file: "screen.mp4", durationMs, ...frameStats, ...(spans.length ? { spans } : {}) }
                : undefined,
            outcome,
            markers: activeControl.markers,
            // Since 2026-11-08 a marker counts from the movie's first frame; a manifest without this key counted from
            // when the session heard of that frame, about a second later, so its markers sit early.
            markerClock: "movie",
        },
        warnings,
    });
    log.info({ id, outcome, durationMs, warnings: warnings.length }, "video recording ended");
    let removed = false;

    if (outcome === "failed" && (await recordedNothing(folder))) {
        try {
            removed = trashRecordingFolder(folder, "recording-failed-start");
            log.info({ id, folder, removed }, "the failed start recorded nothing; its folder goes to the trash");
        } catch (error) {
            log.warn({ error, folder }, "the failed start's empty folder stays in the library");
        }
    }

    return {
        outcome,
        id,
        folder,
        movie: existsSync(movie) ? movie : undefined,
        cursorTrack: existsSync(cursorTrack) ? cursorTrack : undefined,
        durationMs,
        ...frameStats,
        warnings,
        ...(removed ? { removed } : {}),
        ...(cameraProblem?.code === "camera-missing" ? { cameraMissing: true } : {}),
    };
}
