import { existsSync } from "node:fs";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { logger } from "@genesiscz/utils/logger";
import { audioStreamCount, primaryVideo, readMediaFacts } from "@genesiscz/utils/video/media-facts";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import type { CaptureSpec } from "./capture-plan";
import { CaptureRunError, runCapturePlanWithSignal } from "./capture-runner";
import { captureFromFlags, validateCaptureOptions } from "./native-record";
import {
    concatCopyArgv,
    concatListLine,
    cursorTrackPath,
    joinCursorTracks,
    joinSegmentsArgv,
    type MovieRates,
    type SegmentJoiner,
    type SegmentRecorder,
    type SegmentResult,
} from "./recording-session";
import type { RecordingTarget } from "./recording-targets";

const { log } = logger.scoped("control-recording-native");

/** The `[screen-recording-denied]` code GenesisKit's `WidgetCaptureError` already recognizes. */
export const SCREEN_RECORDING_DENIED = "screen-recording-denied";

/**
 * Motion threshold for the recorder's frame-rate policy. A session keeps one PNG (`maxFrames: 1`), so the threshold
 * only decides when the stream drops to the idle rate; a low one keeps typing and small edits at the active rate.
 */
export const SESSION_MOTION_THRESHOLD = 0.5;

export interface NativeRecorderOptions {
    /** CG window ids no movie may show: the host's own recording controls. */
    excludeWindowIds?: number[];
    /** The recorder's frame rate while something moves (0.5–120). */
    fps?: number;
    /** False hides the red border around what is recorded (it never shows in the movie either way). */
    indicator?: boolean;
    /** Audio tracks in each segment's movie, joined with the video. */
    audio?: ("system" | "mic")[];
    /** The microphone's input UID from `ax-tool audio-devices`; needs audio "mic". */
    micDevice?: string;
    /** Each segment writes `<segment>.cursor.jsonl`; the joiner makes `<output>.cursor.jsonl` of them. */
    cursorTrack?: boolean;
    /** Needs cursorTrack: the movie records without the system cursor and its images go here, for the editor to draw. */
    cursorShapes?: string;
    /** Needs cursorTrack: the ⌘/⌃ shortcuts pressed go into the track for the editor's keys overlay. */
    shortcuts?: boolean;
    /** The recorder's frame rate while nothing moves (0.1–5); by default a movie keeps the active rate. */
    idleFps?: number;
    /** The share of the picture that must change, in percent, before the stream leaves the idle rate (0–100). */
    threshold?: number;
}

export { cursorTrackPath };

/** The capture spec one segment records: isolated windows or an app's windows, or a whole display. */
export function segmentCaptureSpec({
    target,
    output,
    maxSeconds,
    options,
}: {
    target: RecordingTarget;
    output: string;
    maxSeconds: number;
    options: NativeRecorderOptions;
}): CaptureSpec {
    const duration = String(Math.max(0.1, Math.min(180, maxSeconds)));
    const common = {
        codec: "h264",
        videoOut: output,
        duration,
        activeFps: options.fps === undefined ? undefined : String(options.fps),
        idleFps: options.idleFps === undefined ? undefined : String(options.idleFps),
        threshold: String(options.threshold ?? SESSION_MOTION_THRESHOLD),
    } as const;
    let spec: CaptureSpec;
    if (target.kind === "display") {
        spec = {
            mode: "screen",
            backend: "native",
            // A following recording picks its own start display (the pointer's) and switches live.
            ...(target.follow ? { followFocus: true } : { screenIndex: target.screenIndex }),
            duration: Number(duration),
            codec: "h264",
            videoOut: output,
            activeFps: options.fps,
            idleFps: options.idleFps,
            threshold: options.threshold ?? SESSION_MOTION_THRESHOLD,
        };
    } else if (target.kind === "region") {
        spec = {
            mode: "region",
            backend: "native",
            region: [target.x, target.y, target.width, target.height].map((value) => Math.round(value)).join(","),
            duration: Number(duration),
            codec: "h264",
            videoOut: output,
            activeFps: options.fps,
            idleFps: options.idleFps,
            threshold: options.threshold ?? SESSION_MOTION_THRESHOLD,
        };
    } else if (target.kind === "window") {
        spec = captureFromFlags({ ...common, windowIds: target.windowIds.join(",") });
    } else {
        spec = captureFromFlags({ ...common, includeApp: [target.app] });
    }

    spec.maxFrames = 1;
    if (options.indicator === false) {
        spec.indicator = false;
    }

    if (options.excludeWindowIds?.length) {
        spec.excludeWindowIds = options.excludeWindowIds;
    }

    if (options.audio?.length) {
        spec.audio = options.audio;

        if (options.micDevice) {
            spec.micDevice = options.micDevice;
        }
    }

    if (options.cursorTrack) {
        spec.cursorTrack = cursorTrackPath(output);

        if (options.cursorShapes) {
            spec.cursorShapes = options.cursorShapes;
        }

        if (options.shortcuts) {
            spec.shortcuts = true;
        }
    }

    validateCaptureOptions(spec);
    return spec;
}

/** A failure text that names a missing Screen Recording grant carries the code a host handles itself. */
export function refusalCode(message: string): string | undefined {
    return /Screen Recording is not granted/i.test(message) ? SCREEN_RECORDING_DENIED : undefined;
}

/**
 * The recorder's options with a session's rates on top. An idle rate equal to the active one is "keep one rate", which
 * ax-tool spells as no `--idle-fps` (it takes 0.1–5 there).
 */
function withRates(options: NativeRecorderOptions, rates: MovieRates | undefined): NativeRecorderOptions {
    if (!rates) {
        return options;
    }

    return {
        ...options,
        fps: rates.activeFps,
        idleFps: rates.idleFps < rates.activeFps ? rates.idleFps : undefined,
        threshold: rates.threshold,
    };
}

/** One `tools control capture record` run per segment, on the ScreenCaptureKit recorder. */
export function nativeSegmentRecorder(options: NativeRecorderOptions = {}): SegmentRecorder {
    return {
        async record({ target, rates, output, maxSeconds, signal, onRecording, onPreparing }): Promise<SegmentResult> {
            const capture = segmentCaptureSpec({ target, output, maxSeconds, options: withRates(options, rates) });
            let sessionDir: string | undefined;
            try {
                const result = await runCapturePlanWithSignal({
                    plan: { capture, actions: [] },
                    signal,
                    onRecording,
                    onPreparing,
                });
                sessionDir = result.sessionDir;
                const envelope = result.capture as {
                    error?: unknown;
                    data?: { stats?: { durationMs?: unknown } };
                } | null;
                const reported = envelope?.data?.stats?.durationMs;
                const durationMs = typeof reported === "number" && reported > 0 ? reported : undefined;
                const endedBy = signal.aborted ? "stop" : result.captureFailed ? "failure" : "deadline";
                const error =
                    typeof envelope?.error === "string" ? envelope.error : result.warnings.at(-1) || undefined;
                // A stop can land on a recorder that already failed, or kill one that did not finish its movie in
                // time, so a failed run's movie is probed whatever ended it: an unfinished one would break every save.
                const ok = existsSync(output) && (!result.captureFailed || (await playable(output)));
                if (!result.captureFailed) {
                    return { ok, endedBy, durationMs };
                }

                const code = error ? refusalCode(error) : undefined;
                return { ok, endedBy, durationMs, error: code ? `[${code}] ${error}` : error, code };
            } catch (error) {
                const message =
                    error instanceof CaptureRunError || error instanceof Error ? error.message : String(error);
                const code = refusalCode(message);
                return {
                    ok: false,
                    endedBy: signal.aborted ? "stop" : "failure",
                    error: code ? `[${code}] ${message}` : message,
                    code,
                };
            } finally {
                // The recorder writes its PNG frames and metadata into a session folder of its own; the movie is
                // the product, so the folder goes with the run.
                if (sessionDir) {
                    await rm(sessionDir, { recursive: true, force: true });
                }
            }
        },
    };
}

/** A movie a failed run left behind is kept only when ffprobe can read it. */
async function playable(path: string): Promise<boolean> {
    try {
        await probeVideo({ input: path });
        return true;
    } catch (error) {
        log.warn({ error, path }, "a failed recording left an unreadable movie; dropping it");
        try {
            await unlink(path);
        } catch (cleanupError) {
            log.debug({ error: cleanupError, path }, "unreadable movie already gone");
        }

        return false;
    }
}

/**
 * Joins the segments into one MP4. Segments of one size and codec with the same audio tracks (one display, no
 * window switch) are copied as they are, audio included: no decode, no quality loss, seconds for an hour. Anything
 * else is re-encoded at the first segment's size, keeping the audio when every segment has a track. The segments'
 * cursor tracks become `<output>.cursor.jsonl`.
 */
export const ffmpegSegmentJoiner: SegmentJoiner = async ({ segments, output }) => {
    const facts = await Promise.all(segments.map((segment) => readMediaFacts({ input: segment.path })));
    const videos = facts.map(primaryVideo);
    const first = videos[0];
    const audioCounts = facts.map(audioStreamCount);
    const sameShape =
        first !== null &&
        videos.every(
            (video) => video?.codec === first.codec && video.width === first.width && video.height === first.height
        ) &&
        audioCounts.every((count) => count === audioCounts[0]);
    const totalMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
    const timeoutMs = Math.max(120_000, totalMs * 2);

    if (sameShape) {
        const list = `${output}.concat.txt`;
        await writeFile(list, `${segments.map((segment) => concatListLine(segment.path)).join("\n")}\n`);
        try {
            await runVideoCommand({ command: concatCopyArgv({ list, output }), timeoutMs });
        } finally {
            await rm(list, { force: true });
        }
    } else {
        const probe = await probeVideo({ input: segments[0].path });
        const argv = joinSegmentsArgv({
            inputs: segments.map((segment) => segment.path),
            width: probe.displayWidth,
            height: probe.displayHeight,
            output,
            audio: audioCounts.every((count) => count > 0),
        });
        await runVideoCommand({ command: argv, timeoutMs });
    }

    log.info(
        { segments: segments.length, output, copied: sameShape, audioTracks: audioCounts[0] ?? 0 },
        sameShape ? "segments joined by stream copy" : "segments joined by re-encoding"
    );
    await joinSegmentCursorTracks(segments, output);
    const joined = await probeVideo({ input: output });
    return { durationMs: Math.round(joined.durationUs / 1000) };
};

async function joinSegmentCursorTracks(
    segments: Array<{ path: string; durationMs: number }>,
    output: string
): Promise<void> {
    const parts: Array<{ text: string; offsetMs: number }> = [];
    let offsetMs = 0;

    for (const segment of segments) {
        const path = cursorTrackPath(segment.path);

        if (existsSync(path)) {
            parts.push({ text: await readFile(path, "utf8"), offsetMs });
        }

        offsetMs += segment.durationMs;
    }

    if (parts.length > 0) {
        await writeFile(cursorTrackPath(output), joinCursorTracks(parts));
    }
}
