import {
    defaultRecordingTarget,
    listRecordingTargets,
    parseRegionTarget,
    parseWindowIdList,
    type RecordingTarget,
} from "@app/control/lib/recording-targets";
import { FRAME_NAMINGS, OCR_SINK_KINDS } from "@genesiscz/utils/screen-recorder/frame-output";
import { FRAME_FLUSHES } from "@genesiscz/utils/screen-recorder/start";
import { Command, Option } from "commander";
import { z } from "zod";
import type { VideoRecordingOptions } from "./video-recording";

/**
 * The options of `tools recorder start` in one place. The CLI declares its flags here and parses them here, and
 * `movies.record()` turns its options into the same flags and checks them with the same parse before it starts the
 * CLI in its own process, so the two doors take the same names, values and limits. The capture picker writes the same
 * command line (Recorder/Capture/CaptureOptions.swift `startArguments`).
 */

/** The longest video recording `tools recorder start` takes: four hours, in 180 s segments. */
export const VIDEO_RECORDING_MAX_SECONDS = 4 * 60 * 60;

export const START_AUDIO_SOURCES = ["system", "mic"] as const;
export type StartAudioSource = (typeof START_AUDIO_SOURCES)[number];

interface Limit {
    min: number;
    max: number;
    int?: boolean;
}

/** The number limits both doors check. */
export const START_LIMITS = {
    fps: { min: 1, max: 120 },
    idleFps: { min: 0.1, max: 5 },
    threshold: { min: 0, max: 100 },
    display: { min: 0, max: 16, int: true },
    maxSeconds: { min: 1, max: VIDEO_RECORDING_MAX_SECONDS },
    /** The capture picker's range (its stepper goes 1 to 10). */
    countdown: { min: 1, max: 10, int: true },
} as const satisfies Record<string, Limit>;

/** A bare `--countdown` (or `countdown: true`): the capture picker's default. */
export const DEFAULT_COUNTDOWN_SECONDS = 3;

/** What commander gives for the flags of `tools recorder start`. */
export interface StartFlags {
    audio?: string;
    startGate?: string;
    micDevice?: string;
    fps?: string;
    idleFps?: string;
    threshold?: string;
    region?: string;
    excludeWindowIds?: string;
    camera?: boolean;
    countdown?: string | boolean;
    display?: string;
    window?: string;
    app?: string;
    title?: string;
    maxSeconds?: string;
    indicator?: boolean;
    systemCursor?: boolean;
    shortcuts?: boolean;
    controls?: boolean;
    open?: boolean;
    json?: boolean;
    /** `--frames [format]`: a frames recording (`recorder.start()` of the REPL) instead of a movie. */
    frames?: string | boolean;
    jpegQuality?: string;
    naming?: string | boolean;
    flush?: string | boolean;
    ocr?: boolean;
    ocrLanguages?: string;
    ocrMinChars?: string;
    ocrSink?: string | boolean;
    displays?: string;
    maxLongSide?: string;
    heartbeat?: string;
    pieceSeconds?: string;
}

/** A movie's frame rate when `--fps` is not given (a frames recording keeps the library recorder's own). */
export const DEFAULT_MOVIE_FPS = 60;

/** Declares the flags of `tools recorder start` on `command`. */
export function withStartOptions(command: Command): Command {
    const { countdown, idleFps, threshold } = START_LIMITS;
    return command
        .option("--audio <sources>", "audio tracks: system, mic, or system,mic")
        .option("--mic-device <uid>", "the microphone (an id from `ax-tool audio-devices`; needs --audio mic)")
        .option(
            "--fps <n>",
            `frames per second while something moves, 1–120 (default ${DEFAULT_MOVIE_FPS} for a movie)`
        )
        .option(
            "--idle-fps <n>",
            `frames per second while nothing moves, ${idleFps.min}–${idleFps.max} (by default the movie keeps --fps)`
        )
        .option(
            "--threshold <percent>",
            `how much of the picture must change to leave the idle rate, ${threshold.min}–${threshold.max} (default 0.5)`
        )
        .option(
            "--display <index>",
            "record only this display (NSScreen order); by default the recording follows the pointer and the focus to whichever screen is in use"
        )
        .option("--window <ids>", "record these windows (CG window ids, comma separated)")
        .option("--app <name>", "record this app's windows (name, bundle id or pid)")
        .option("--region <x,y,w,h>", "record this area of a display, in screen points from the top-left corner")
        .option("--exclude-window-ids <ids>", "leave these windows out of the movie (CG window ids, comma separated)")
        .option(
            "--camera",
            "record the camera beside the screen into camera.mov (the menu bar recorder records it and must run; the editor draws the bubble)"
        )
        .option(
            "--countdown [seconds]",
            `count down on screen before it records, ${countdown.min}–${countdown.max} s (bare: ${DEFAULT_COUNTDOWN_SECONDS} s), as the capture picker does`
        )
        .option("--title <text>", "the recording's title in the library and the menu")
        .option("--max-seconds <n>", `stop after this long, 1–${VIDEO_RECORDING_MAX_SECONDS}`)
        .option("--no-indicator", "no red border around what is recorded (never in the movie either way)")
        .option(
            "--no-shortcuts",
            "do not keep the ⌘/⌃ shortcuts pressed (by default they go into the cursor track for the keys overlay; plain typing never does)"
        )
        .option(
            "--system-cursor",
            "keep the system cursor in the movie (by default it stays out and the editor draws it: smoothed, any size)"
        )
        .option("--no-controls", "do not open the floating controls")
        .option("--open", "open the editor when the recording stops")
        .option("--json", "events and the result as JSON lines on stdout")
        .option(
            "--frames [format]",
            "record frames instead of a movie, as recorder.start() in the REPL does: original (the recorder's files, the default) or jpeg"
        )
        .option("--jpeg-quality <q>", "with --frames jpeg: the JPEG quality, 0.1–1 (default 0.75)")
        .option("--naming [naming]", `with --frames: how frames are named, ${FRAME_NAMINGS.join(" or ")}`)
        .option(
            "--flush [when]",
            `with --frames: ${FRAME_FLUSHES.join(" (all at the stop) or ")} (each piece's frames land as the piece ends)`
        )
        .option("--ocr", "with --frames: read the text of each kept frame (Vision OCR)")
        .option(
            "--ocr-languages <list>",
            "with --frames: the OCR languages in order of preference (en-US,cs-CZ); turns OCR on"
        )
        .option("--ocr-min-chars <n>", "with --frames: OCR text shorter than this is stored as no text; turns OCR on")
        .option(
            "--ocr-sink [sink]",
            `with --frames: where the OCR goes, ${OCR_SINK_KINDS.join(" (a <frame>.ocr.json beside each frame) or ")} (one ocr.jsonl row per frame)`
        )
        .option("--displays <which>", "with --frames: all, main (the default) or display ids, comma separated")
        .option("--max-long-side <px>", "with --frames: the longest side of a kept frame, 320–16384")
        .option("--heartbeat <seconds>", "with --frames: a frame at least this often while nothing changes, 0 is off")
        .option("--piece-seconds <n>", "with --frames: the length of one capture piece, 5–180")
        .addOption(
            new Option("--start-gate <path>", "the start gate of a caller that waits for this recording").hideHelp()
        );
}

/** The flags of an argv for `tools recorder start` (without `recorder start`), read by the CLI's own declarations. */
export function readStartArgs(args: readonly string[]): StartFlags {
    const command = withStartOptions(new Command("start"))
        .exitOverride()
        .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    command.parse([...args], { from: "user" });
    return command.opts<StartFlags>();
}

function bounded(raw: string | undefined, name: string, limit: Limit): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const value = Number(raw);

    if (!Number.isFinite(value) || value < limit.min || value > limit.max || (limit.int && !Number.isInteger(value))) {
        const kind = limit.int ? "a whole number" : "a number";
        throw new Error(`${name} takes ${kind} from ${limit.min} to ${limit.max} (got "${raw}")`);
    }

    return value;
}

function parseAudio(raw: string | undefined): StartAudioSource[] | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const sources = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const known = sources.filter((value): value is StartAudioSource =>
        START_AUDIO_SOURCES.some((source) => source === value)
    );

    if (known.length !== sources.length) {
        throw new Error(`--audio takes system, mic or system,mic (got "${raw}")`);
    }

    return known;
}

/** `--countdown [seconds]`: undefined when not given, the picker's 3 s when bare. */
export function countdownSecondsOf(raw: string | boolean | undefined): number | undefined {
    if (raw === undefined || raw === false) {
        return undefined;
    }

    return raw === true ? DEFAULT_COUNTDOWN_SECONDS : bounded(raw, "--countdown", START_LIMITS.countdown);
}

/** The target the flags name, in this order: an area, windows, an app, a display; undefined when they name none. */
function namedTarget(flags: StartFlags): RecordingTarget | undefined {
    if (flags.region) {
        return parseRegionTarget(flags.region);
    }

    const windowIds = parseWindowIdList(flags.window, "--window");

    if (windowIds) {
        return { kind: "window", windowIds };
    }

    if (flags.app) {
        return { kind: "app", app: flags.app };
    }

    if (flags.display !== undefined) {
        return { kind: "display", screenIndex: bounded(flags.display, "--display", START_LIMITS.display) ?? 0 };
    }

    return undefined;
}

/** A start as the flags ask for it; `target` is undefined when they name none (the recording follows the screen). */
export type StartRequest = Omit<VideoRecordingOptions, "target" | "emit" | "prepare" | "countdown"> & {
    target?: RecordingTarget;
};

/** Checks and converts the flags; throws one plain message naming the flag that is wrong. */
/** `--audio` and `--mic-device`; the device without the microphone is refused, since it would record nothing. */
export function startAudioOf(flags: StartFlags): StartAudioSource[] | undefined {
    const audio = parseAudio(flags.audio);

    if (flags.micDevice !== undefined && !audio?.includes("mic")) {
        throw new Error("--mic-device needs --audio mic (or system,mic): without the microphone it records nothing");
    }

    return audio;
}

export function parseStartFlags(flags: StartFlags): StartRequest {
    const audio = startAudioOf(flags);

    return {
        target: namedTarget(flags),
        title: flags.title,
        fps: bounded(flags.fps ?? String(DEFAULT_MOVIE_FPS), "--fps", START_LIMITS.fps),
        idleFps: bounded(flags.idleFps, "--idle-fps", START_LIMITS.idleFps),
        threshold: bounded(flags.threshold, "--threshold", START_LIMITS.threshold),
        excludeWindowIds: parseWindowIdList(flags.excludeWindowIds, "--exclude-window-ids"),
        camera: flags.camera === true,
        countdownSeconds: countdownSecondsOf(flags.countdown),
        audio,
        micDevice: flags.micDevice,
        maxSeconds: bounded(flags.maxSeconds, "--max-seconds", START_LIMITS.maxSeconds),
        indicator: flags.indicator,
        systemCursor: flags.systemCursor,
        shortcuts: flags.shortcuts,
        panel: flags.controls !== false,
        startGate: flags.startGate,
    };
}

/** No target named: the main display, followed to whichever screen the pointer or the focused window moves to. */
export async function defaultStartTarget(): Promise<RecordingTarget> {
    const targets = await listRecordingTargets();
    const main = targets.displays.find((display) => display.isPrimary) ?? targets.displays[0];
    return main
        ? { kind: "display", screenIndex: main.index, follow: true }
        : (defaultRecordingTarget(targets, new Set()) ?? { kind: "display", screenIndex: 0 });
}

// `.int()` goes first: after min and max it puts the safe-integer range into the JSON Schema, and describe() then
// shows no limits.
const limited = (limit: Limit) => (limit.int ? z.number().int() : z.number()).min(limit.min).max(limit.max);

/** `movies.record()`'s options: the flags of `tools recorder start` in camelCase, with the same limits. */
export const recordOptionsSchema = z
    .object({
        audio: z.array(z.enum(START_AUDIO_SOURCES)).optional(),
        /** The microphone's id (`ax-tool audio-devices`); needs audio: ["mic"]. */
        micDevice: z.string().min(1).optional(),
        title: z.string().optional(),
        maxSeconds: limited(START_LIMITS.maxSeconds).optional(),
        display: limited(START_LIMITS.display).optional(),
        app: z.string().optional(),
        window: z.array(z.number().int().positive()).optional(),
        /** "x,y,width,height" in screen points from the top-left corner, as --region takes it. */
        region: z
            .string()
            .superRefine((raw, ctx) => {
                try {
                    parseRegionTarget(raw);
                } catch (error) {
                    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
                }
            })
            .optional(),
        /** CG window ids the movie leaves out. */
        excludeWindowIds: z.array(z.number().int().positive()).optional(),
        fps: limited(START_LIMITS.fps).optional(),
        idleFps: limited(START_LIMITS.idleFps).optional(),
        threshold: limited(START_LIMITS.threshold).optional(),
        /** Seconds counted down on screen before it records; true is the picker's 3 s. */
        countdown: z.union([z.boolean(), limited(START_LIMITS.countdown)]).optional(),
        /** Keep the system cursor in the movie instead of the drawn one. */
        systemCursor: z.boolean().optional(),
        /** False keeps the ⌘/⌃ shortcuts out of the cursor track (no keys overlay). */
        shortcuts: z.boolean().optional(),
        controls: z.boolean().optional(),
        /** The red border around what is recorded (never in the movie). */
        indicator: z.boolean().optional(),
        /** Records the camera beside the screen (camera.mov); the menu bar recorder records it and must run. */
        camera: z.boolean().optional(),
    })
    .strict();

export type RecordOptions = z.infer<typeof recordOptionsSchema>;

/** One entry per option, so an option without its flag is a compile error. */
const START_ARGS: { [K in keyof Required<RecordOptions>]: (options: RecordOptions) => string[] } = {
    audio: ({ audio }) => (audio?.length ? ["--audio", audio.join(",")] : []),
    micDevice: ({ micDevice }) => (micDevice ? ["--mic-device", micDevice] : []),
    title: ({ title }) => (title ? ["--title", title] : []),
    maxSeconds: ({ maxSeconds }) => (maxSeconds === undefined ? [] : ["--max-seconds", String(maxSeconds)]),
    display: ({ display }) => (display === undefined ? [] : ["--display", String(display)]),
    app: ({ app }) => (app ? ["--app", app] : []),
    window: ({ window }) => (window?.length ? ["--window", window.join(",")] : []),
    region: ({ region }) => (region ? ["--region", region] : []),
    excludeWindowIds: ({ excludeWindowIds }) =>
        excludeWindowIds?.length ? ["--exclude-window-ids", excludeWindowIds.join(",")] : [],
    fps: ({ fps }) => (fps === undefined ? [] : ["--fps", String(fps)]),
    idleFps: ({ idleFps }) => (idleFps === undefined ? [] : ["--idle-fps", String(idleFps)]),
    threshold: ({ threshold }) => (threshold === undefined ? [] : ["--threshold", String(threshold)]),
    countdown: ({ countdown }) =>
        countdown === undefined || countdown === false
            ? []
            : countdown === true
              ? ["--countdown"]
              : ["--countdown", String(countdown)],
    systemCursor: ({ systemCursor }) => (systemCursor ? ["--system-cursor"] : []),
    shortcuts: ({ shortcuts }) => (shortcuts === false ? ["--no-shortcuts"] : []),
    controls: ({ controls }) => (controls === false ? ["--no-controls"] : []),
    indicator: ({ indicator }) => (indicator === false ? ["--no-indicator"] : []),
    camera: ({ camera }) => (camera ? ["--camera"] : []),
};

/** The flags of `tools recorder start` for `movies.record()`'s options. */
export function startArgsOf(options: RecordOptions): string[] {
    return Object.values(START_ARGS).flatMap((toArgs) => toArgs(options));
}
