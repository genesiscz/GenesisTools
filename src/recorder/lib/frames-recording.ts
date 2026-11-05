import { ensureBinaryAsync } from "@app/control/lib/runner";
import { parseFlags } from "@genesiscz/utils/cli/flag-issues";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { logger } from "@genesiscz/utils/logger";
import { libraryStartOptions, recorderStartSchema } from "@genesiscz/utils/repl/toolsets/recorder";
import type { StopAnswer } from "@genesiscz/utils/screen-recorder/control";
import { FRAME_RECORDERS } from "@genesiscz/utils/screen-recorder/recorders";
import {
    type LibraryRecording,
    type StartRecordingOptions,
    startRecording,
} from "@genesiscz/utils/screen-recorder/start";
import type { FrameRecorder } from "@genesiscz/utils/screen-recorder/types";
import type { z } from "zod";
import { type StartFlags, startAudioOf } from "./start-options";
import { showRecorderCountdown } from "./video-recording";

const { log } = logger.scoped("recorder-frames");

/**
 * `tools recorder start --frames`: the library recorder's frames recording (JPEG or the recorder's own files, OCR
 * into `<frame>.ocr.json` or `ocr.jsonl`, frames flushed at the stop or per piece), the CLI door of the REPL's
 * `recorder.start()`. The flags become that method's options and are checked by its schema, so both doors take the
 * same values.
 */

export type FramesStart = z.infer<typeof recorderStartSchema>;

/** A flag only a movie reads: refused with `--frames`, which would drop it. */
const MOVIE_ONLY: ReadonlyArray<readonly [string, (flags: StartFlags) => boolean]> = [
    ["--display (a frames recording takes --displays)", (flags) => flags.display !== undefined],
    ["--window", (flags) => flags.window !== undefined],
    ["--app", (flags) => flags.app !== undefined],
    ["--region", (flags) => flags.region !== undefined],
    ["--exclude-window-ids", (flags) => flags.excludeWindowIds !== undefined],
    ["--camera", (flags) => flags.camera === true],
    ["--system-cursor", (flags) => flags.systemCursor === true],
    ["--no-shortcuts", (flags) => flags.shortcuts === false],
    ["--no-indicator", (flags) => flags.indicator === false],
    ["--no-controls", (flags) => flags.controls === false],
    ["--open", (flags) => flags.open === true],
    ["--start-gate", (flags) => flags.startGate !== undefined],
];

/** A flag only a frames recording reads: refused without `--frames`. */
const FRAMES_ONLY: ReadonlyArray<readonly [string, (flags: StartFlags) => boolean]> = [
    ["--jpeg-quality", (flags) => flags.jpegQuality !== undefined],
    ["--naming", (flags) => flags.naming !== undefined],
    ["--flush", (flags) => flags.flush !== undefined],
    ["--ocr", (flags) => flags.ocr === true],
    ["--ocr-languages", (flags) => flags.ocrLanguages !== undefined],
    ["--ocr-min-chars", (flags) => flags.ocrMinChars !== undefined],
    ["--ocr-sink", (flags) => flags.ocrSink !== undefined],
    ["--displays", (flags) => flags.displays !== undefined],
    ["--max-long-side", (flags) => flags.maxLongSide !== undefined],
    ["--heartbeat", (flags) => flags.heartbeat !== undefined],
    ["--piece-seconds", (flags) => flags.pieceSeconds !== undefined],
];

/** The flag of each field of `recorder.start()`'s options, so a refusal names what was typed. */
const FRAMES_FLAGS = {
    title: "--title",
    displays: "--displays",
    audio: "--audio",
    "audio.micDeviceId": "--mic-device",
    fps: "--fps",
    idleFps: "--idle-fps",
    threshold: "--threshold",
    maxLongSide: "--max-long-side",
    heartbeatSec: "--heartbeat",
    ocr: "--ocr",
    "ocr.languages": "--ocr-languages",
    "ocr.minChars": "--ocr-min-chars",
    ocrSink: "--ocr-sink",
    frames: "--frames",
    "frames.format": "--frames",
    "frames.jpegQuality": "--jpeg-quality",
    "frames.naming": "--naming",
    "frames.flush": "--flush",
    maxDurationSec: "--max-seconds",
    pieceSec: "--piece-seconds",
};

/** Whether the flags ask for a frames recording. */
export function wantsFrames(flags: StartFlags): boolean {
    return flags.frames !== undefined && flags.frames !== false;
}

/** Refuses a flag the chosen kind of recording would not read, naming every one. */
export function refuseOtherKindFlags(flags: StartFlags): void {
    const frames = wantsFrames(flags);
    const wrong = (frames ? MOVIE_ONLY : FRAMES_ONLY).filter(([, given]) => given(flags)).map(([flag]) => flag);

    if (wrong.length > 0) {
        throw new Error(
            frames
                ? `A frames recording (--frames) does not take ${wrong.join(", ")}`
                : `${wrong.join(", ")} need${wrong.length === 1 ? "s" : ""} --frames (a frames recording); a movie does not take ${wrong.length === 1 ? "it" : "them"}`
        );
    }
}

function number(raw: string | undefined): number | undefined {
    return raw === undefined ? undefined : Number(raw);
}

function list(raw: string | undefined): string[] | undefined {
    return raw
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}

/** `--displays all|main|<ids>`. */
function displaysOf(raw: string | undefined): FramesStart["displays"] | undefined {
    if (raw === undefined || raw === "all" || raw === "main") {
        return raw;
    }

    return list(raw)?.map(Number);
}

/** A bare enumerated flag (`--naming` with no value) is not a value; the CLI asks for one before this parse. */
function value(raw: string | boolean | undefined): string | undefined {
    return typeof raw === "string" ? raw : undefined;
}

/** The flags as the options of `recorder.start()`, checked by its schema; throws one message naming the flags. */
export function framesStartOf(flags: StartFlags): FramesStart {
    refuseOtherKindFlags(flags);
    const audio = startAudioOf(flags);
    const ocrGiven = flags.ocr === true || flags.ocrLanguages !== undefined || flags.ocrMinChars !== undefined;
    return parseFlags(
        recorderStartSchema,
        {
            title: flags.title,
            displays: displaysOf(flags.displays),
            audio: audio
                ? {
                      mic: audio.includes("mic"),
                      system: audio.includes("system"),
                      ...(flags.micDevice ? { micDeviceId: flags.micDevice } : {}),
                  }
                : undefined,
            fps: number(flags.fps),
            idleFps: number(flags.idleFps),
            threshold: number(flags.threshold),
            maxLongSide: number(flags.maxLongSide),
            heartbeatSec: number(flags.heartbeat),
            ocr: ocrGiven ? { languages: list(flags.ocrLanguages), minChars: number(flags.ocrMinChars) } : undefined,
            ocrSink: value(flags.ocrSink),
            frames: {
                format: value(flags.frames),
                jpegQuality: number(flags.jpegQuality),
                naming: value(flags.naming),
                flush: value(flags.flush),
            },
            maxDurationSec: number(flags.maxSeconds),
            pieceSec: number(flags.pieceSeconds),
        },
        FRAMES_FLAGS
    );
}

export interface FramesRecordingOptions {
    start: FramesStart;
    countdownSeconds?: number;
    countdown?: (seconds: number) => Promise<void>;
    /** The frame recorder; default the native one (ax-tool), as the REPL's recorder toolset builds it. */
    recorder?: () => FrameRecorder;
    /** The JPEG converter and the OCR; default the real ones. */
    deps?: StartRecordingOptions["deps"];
    /** Called once the recording runs (its live entry exists). */
    onStart?: (recording: LibraryRecording) => void;
}

const nativeRecorder = () => FRAME_RECORDERS.native({ axTool: async (options) => [await ensureBinaryAsync(options)] });

/** Records frames until the stop command, the menu bar item, Ctrl-C or the length limit; resolves after the finish. */
export async function recordFrames(
    options: FramesRecordingOptions
): Promise<StopAnswer & { id: string; folder: string }> {
    const countdownSeconds = options.countdownSeconds ?? 0;

    if (countdownSeconds > 0) {
        await ensureBinaryAsync();
        await (options.countdown ?? showRecorderCountdown)(countdownSeconds);
    }

    const recording = await startRecording({
        recorder: (options.recorder ?? nativeRecorder)(),
        ...libraryStartOptions(options.start),
        ...(options.deps ? { deps: options.deps } : {}),
    });
    log.info({ id: recording.id, folder: recording.folder, start: options.start }, "frames recording started");
    options.onStart?.(recording);
    const answer = await withInterrupt(
        async (signal) => {
            signal.addEventListener(
                "abort",
                () =>
                    void recording.stop().catch((error: unknown) => {
                        log.debug({ error }, "the frames recording was stopping already");
                    }),
                { once: true }
            );
            return await recording.finished;
        },
        { handleTermination: true }
    );
    log.info({ id: recording.id, outcome: answer.outcome, frames: answer.frames }, "frames recording ended");
    return { ...answer, id: recording.id, folder: recording.folder };
}
