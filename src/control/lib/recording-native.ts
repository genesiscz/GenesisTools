import { existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { logger } from "@genesiscz/utils/logger";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import type { CaptureSpec } from "./capture-plan";
import { CaptureRunError, runCapturePlanWithSignal } from "./capture-runner";
import { captureFromFlags, validateCaptureOptions } from "./native-record";
import { joinSegmentsArgv, type SegmentJoiner, type SegmentRecorder, type SegmentResult } from "./recording-session";
import type { RecordingTarget } from "./recording-targets";

const { log } = logger.scoped("control-recording-native");

/** The `[screen-recording-denied]` code GenesisKit's `WidgetCaptureError` already recognizes. */
export const SCREEN_RECORDING_DENIED = "screen-recording-denied";

/**
 * Motion threshold for the recorder's frame-rate policy. A session keeps one PNG (`maxFrames: 1`), so the threshold
 * only decides when the stream drops to the idle rate; a low one keeps typing and small edits at the active rate.
 */
const SESSION_MOTION_THRESHOLD = 0.5;

export interface NativeRecorderOptions {
    /** CG window ids no movie may show: the host's own recording controls. */
    excludeWindowIds?: number[];
    /** The recorder's frame rate while something moves (0.5–30). */
    fps?: number;
    /** False hides the red border around what is recorded (it never shows in the movie either way). */
    indicator?: boolean;
}

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
        threshold: String(SESSION_MOTION_THRESHOLD),
    } as const;
    let spec: CaptureSpec;
    if (target.kind === "display") {
        spec = {
            mode: "screen",
            backend: "native",
            screenIndex: target.screenIndex,
            duration: Number(duration),
            codec: "h264",
            videoOut: output,
            activeFps: options.fps,
            threshold: SESSION_MOTION_THRESHOLD,
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

    validateCaptureOptions(spec);
    return spec;
}

/** A failure text that names a missing Screen Recording grant carries the code a host handles itself. */
export function refusalCode(message: string): string | undefined {
    return /Screen Recording is not granted/i.test(message) ? SCREEN_RECORDING_DENIED : undefined;
}

/** One `tools control capture record` run per segment, on the ScreenCaptureKit recorder. */
export function nativeSegmentRecorder(options: NativeRecorderOptions = {}): SegmentRecorder {
    return {
        async record({ target, output, maxSeconds, signal, onRecording }): Promise<SegmentResult> {
            const capture = segmentCaptureSpec({ target, output, maxSeconds, options });
            let sessionDir: string | undefined;
            try {
                const result = await runCapturePlanWithSignal({ plan: { capture, actions: [] }, signal, onRecording });
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
                const ok = existsSync(output) && (endedBy !== "failure" || (await playable(output)));
                if (endedBy !== "failure") {
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

/** ffmpeg concat of the segments at the first segment's size; one H.264 MP4. */
export const ffmpegSegmentJoiner: SegmentJoiner = async ({ segments, output }) => {
    const first = await probeVideo({ input: segments[0].path });
    const argv = joinSegmentsArgv({
        inputs: segments.map((segment) => segment.path),
        width: first.displayWidth,
        height: first.displayHeight,
        output,
    });
    const totalMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
    await runVideoCommand({ command: argv, timeoutMs: Math.max(120_000, totalMs * 2) });
    const joined = await probeVideo({ input: output });
    return { durationMs: Math.round(joined.durationUs / 1000) };
};
