import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { audioStreamCount, hasAudio, type MediaFacts, type MediaStream, primaryVideo } from "./media-facts";

/** How the encoder spends bits: a constant quality, or an average bitrate that a size target asks for. */
export type VideoRate =
    | { kind: "quality"; quality: number }
    /** `attempt` counts size-correction passes (0 first); an encoder may loosen a quality floor as it grows. */
    | { kind: "bitrate"; kbps: number; attempt?: number };

/** What happens to the audio tracks: copied as they are, or re-encoded to AAC at a bitrate per track. */
export type AudioPlan = { kind: "copy" } | { kind: "aac"; kbps: number };

/** `--audio`: decide per file (`auto`), always copy, or always re-encode at this many kbit/s. */
export type AudioRequest = "auto" | "copy" | number;

const COPY_AUDIO: AudioPlan = { kind: "copy" };

/** One run of a two-pass encode: pass 1 only writes the statistics file that pass 2 reads. */
export interface EncodePass {
    index: 1 | 2;
    /** The statistics file prefix both passes share. */
    logFile: string;
}

/** The QP cap per size-correction attempt of the GPU encoder; past the list there is no cap. */
const HEVC_QP_CAPS = [36, 42];

function hevcQpCap(attempt = 0): string[] {
    const cap = HEVC_QP_CAPS[attempt];
    return cap === undefined ? [] : ["-qmax", String(cap)];
}

/** A re-encode target. Add a codec by adding one entry to `VIDEO_ENCODERS`; no call site branches on the name. */
export interface VideoEncoder {
    codec: string;
    /** One line for help and `--preset` listings. */
    label: string;
    /** The ffmpeg encoder name, e.g. `hevc_videotoolbox`. */
    ffmpegName: string;
    /** What ffprobe calls the codec of a stream this encoder wrote. */
    streamCodec: string;
    /** `--quality` in this encoder's own scale; `qualityHelp` says which way is better. */
    defaultQuality: number;
    qualityHelp: string;
    /** Containers that can hold this codec, by extension with the dot. */
    containers: readonly string[];
    /** Platforms the encoder runs on (`process.platform` values). */
    platforms: readonly NodeJS.Platform[];
    /** Decode flags for the input, also used to verify the output. */
    decodeArgs: readonly string[];
    /** The video part of the ffmpeg command line; `pass` is set only for an encoder with `twoPass`. */
    videoArgs: (rate: VideoRate, pass?: EncodePass) => string[];
    /** A resize: decode flags that suit the filter, and the scale filter for a target height. */
    scale: { decodeArgs: readonly string[]; filter: (height: number) => string };
    /** A bitrate target runs two passes, which lands within a few percent of the size; no correction pass needed. */
    twoPass: boolean;
}

const SOFTWARE_CONTAINERS = [".mp4", ".m4v", ".mov", ".mkv"] as const;
const ANY_PLATFORM: readonly NodeJS.Platform[] = ["darwin", "linux", "win32"];
/** Lanczos keeps slide text sharper than the default bicubic when a 1080p recording goes to 720p. */
const SOFTWARE_SCALE = { decodeArgs: [], filter: (height: number) => `scale=-2:${height}:flags=lanczos` } as const;
/**
 * A keyframe every 600 frames (20 s at 30 fps). Talks and slides are mostly still, and every keyframe costs a full
 * picture: the default interval spent the budget on them and the picture pulsed at each one (measured 2026-11-02).
 */
const LONG_GOP = ["-g", "600"] as const;

export const VIDEO_ENCODERS = {
    hevc: {
        codec: "hevc",
        label: "HEVC on the GPU (VideoToolbox): fastest, uses almost no CPU, weakest at low bitrates",
        ffmpegName: "hevc_videotoolbox",
        streamCodec: "hevc",
        defaultQuality: 58,
        qualityHelp: "0 to 100, higher is better (58 matches libx265 crf 26)",
        containers: [".mp4", ".m4v", ".mov", ".mkv"],
        platforms: ["darwin"],
        decodeArgs: ["-hwaccel", "videotoolbox"],
        // 10 s of a 720p talk recording at -b:v 420k (2026-11-02, SSIM against the source): a -maxrate cap 0.859 (broken);
        // -g 600 -prio_speed 0 0.978 at 443 kbit/s; adding -bf 2 (ffmpeg leaves B-frames off) 0.979 at 398; adding
        // -qmax 36 (no frame coarser than QP 36) 0.982 at 395. -spatial_aq 1 changed nothing on an M4 Max. The QP cap is
        // also a size floor: on the hardest minute of the talk -b:v 300k gave 1234 kbit/s at -qmax 36, 783 at 42 and
        // 498 with no cap, and the full 108 min stayed at 521 MB for 417, 317 and 241k. So each size correction loosens
        // it (HEVC_QP_CAPS).
        videoArgs: (rate) => [
            "-c:v",
            "hevc_videotoolbox",
            ...(rate.kind === "quality"
                ? ["-q:v", String(rate.quality)]
                : ["-b:v", `${rate.kbps}k`, ...hevcQpCap(rate.attempt)]),
            ...LONG_GOP,
            "-bf",
            "2",
            "-prio_speed",
            "0",
            "-tag:v",
            "hvc1",
        ],
        // Decode and encode on the GPU, scale on the CPU: against the 1080p source, Lanczos scored VMAF 90.1 where the GPU
        // scaler (scale_vt) scored 76.7 at the same bitrate, for 0.6 s more CPU per 10 s of 1080p (measured 2026-11-02).
        scale: {
            decodeArgs: ["-hwaccel", "videotoolbox"],
            filter: (height) => `scale=-2:${height}:flags=lanczos`,
        },
        twoPass: false,
    },
    x264: {
        codec: "x264",
        label: "H.264 on the CPU (x264 slow): plays everywhere, near the best quality, fast for a CPU encoder",
        ffmpegName: "libx264",
        streamCodec: "h264",
        defaultQuality: 23,
        qualityHelp: "CRF 0 to 51, lower is better",
        containers: SOFTWARE_CONTAINERS,
        platforms: ANY_PLATFORM,
        decodeArgs: [],
        videoArgs: (rate, pass) => [
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            ...(rate.kind === "quality" ? ["-crf", String(rate.quality)] : ["-b:v", `${rate.kbps}k`]),
            ...LONG_GOP,
            ...(pass ? ["-pass", String(pass.index), "-passlogfile", pass.logFile] : []),
        ],
        scale: SOFTWARE_SCALE,
        twoPass: true,
    },
    x265: {
        codec: "x265",
        label: "HEVC on the CPU (x265 medium): about the quality of x264 slow, several times slower",
        ffmpegName: "libx265",
        streamCodec: "hevc",
        defaultQuality: 26,
        qualityHelp: "CRF 0 to 51, lower is better",
        containers: SOFTWARE_CONTAINERS,
        platforms: ANY_PLATFORM,
        decodeArgs: [],
        // libx265 takes its pass and statistics file in -x265-params, not in ffmpeg's -pass.
        videoArgs: (rate, pass) => [
            "-c:v",
            "libx265",
            "-preset",
            // slow measured no better than medium with aq-mode=3 on a talk recording, for 2.4 to 2.6 times the time.
            "medium",
            ...(rate.kind === "quality" ? ["-crf", String(rate.quality)] : ["-b:v", `${rate.kbps}k`]),
            "-x265-params",
            [
                "keyint=600",
                "aq-mode=3",
                "log-level=error",
                ...(pass ? [`pass=${pass.index}`, `stats=${pass.logFile}`] : []),
            ].join(":"),
            "-tag:v",
            "hvc1",
        ],
        scale: SOFTWARE_SCALE,
        twoPass: true,
    },
    av1: {
        codec: "av1",
        label: "AV1 on the CPU (SVT-AV1 preset 5): the best quality per byte; older devices may not decode it",
        ffmpegName: "libsvtav1",
        streamCodec: "av1",
        defaultQuality: 35,
        qualityHelp: "CRF 1 to 63, lower is better",
        containers: [".mp4", ".mkv"],
        platforms: ANY_PLATFORM,
        decodeArgs: [],
        videoArgs: (rate) => [
            "-c:v",
            "libsvtav1",
            "-preset",
            "5",
            ...(rate.kind === "quality" ? ["-crf", String(rate.quality)] : ["-b:v", `${rate.kbps}k`]),
            ...LONG_GOP,
            "-svtav1-params",
            "tune=0:film-grain=0",
        ],
        scale: SOFTWARE_SCALE,
        twoPass: false,
    },
} as const satisfies Record<string, VideoEncoder>;

/**
 * Named starting points, one encoder each, picked from a 10 s comparison at 420 kbit/s on a 720p talk recording
 * (2026-11-02, SSIM against the source): fast 0.978, compatible 0.9931, small 0.9949.
 */
export const VIDEO_PRESETS = {
    fast: "hevc",
    compatible: "x264",
    small: "av1",
} as const satisfies Record<string, keyof typeof VIDEO_ENCODERS>;

export type VideoPreset = keyof typeof VIDEO_PRESETS;

export function isVideoPreset(value: string): value is VideoPreset {
    return Object.hasOwn(VIDEO_PRESETS, value);
}

export const VIDEO_PRESET_NAMES: readonly VideoPreset[] = Object.keys(VIDEO_PRESETS).filter(isVideoPreset);

export type VideoEncoderCodec = keyof typeof VIDEO_ENCODERS;

export function isVideoEncoderCodec(value: string): value is VideoEncoderCodec {
    return Object.hasOwn(VIDEO_ENCODERS, value);
}

export const VIDEO_ENCODER_CODECS: readonly VideoEncoderCodec[] =
    Object.keys(VIDEO_ENCODERS).filter(isVideoEncoderCodec);

export function findEncoder(codec: string): VideoEncoder | undefined {
    return Object.values<VideoEncoder>(VIDEO_ENCODERS).find((encoder) => encoder.codec === codec);
}

export const DURATION_TOLERANCE_SEC = 0.5;

/** Every ffmpeg this module starts runs through here, so each one is under `nice -n 10`. */
export function ffmpegCommand(args: readonly string[]): string[] {
    return ["nice", "-n", "10", "ffmpeg", ...args];
}

/** Why the encoder cannot run here, or null. */
export async function encoderUnavailableReason(encoder: VideoEncoder): Promise<string | null> {
    if (!encoder.platforms.includes(process.platform)) {
        return `${encoder.ffmpegName} runs only on ${encoder.platforms.join(", ")}, this is ${process.platform}`;
    }

    const result = await boundedCommand({ command: ffmpegCommand(["-hide_banner", "-encoders"]), timeoutMs: 30_000 });

    if (result.error || result.status !== 0) {
        return `ffmpeg is not available: ${result.error?.message ?? result.stderr.slice(-200)}`;
    }

    return result.stdout.includes(` ${encoder.ffmpegName} `)
        ? null
        : `this ffmpeg has no ${encoder.ffmpegName} encoder (ffmpeg -encoders)`;
}

/** How a skip reason names a stream the encode would not carry over. */
function droppedStream(stream: MediaStream): string {
    if (stream.type === "video") {
        return stream.attachedPicture ? `a cover picture (${stream.codec})` : `a second video track (${stream.codec})`;
    }

    const article = /^[aeiou]/i.test(stream.type) ? "an" : "a";
    return `${article} ${stream.type} track (${stream.codec})`;
}

/**
 * Why an input is not re-encoded, or null when it is a candidate. The encode carries over the first playable video
 * and every audio track (`encodeArgs`), so a file with any other stream (a subtitle, a second video, a cover picture,
 * a data or attachment track) is skipped rather than replaced by a file without it.
 */
export function skipReason({
    facts,
    encoder,
    reshaping = false,
}: {
    facts: MediaFacts;
    encoder: VideoEncoder;
    /** A size target or a smaller height is asked for, so an input already in the codec is still a candidate. */
    reshaping?: boolean;
}): string | null {
    const video = primaryVideo(facts);

    if (!video) {
        return "not a video (no video stream)";
    }

    if (video.codec === encoder.streamCodec && !reshaping) {
        return `already ${encoder.codec}`;
    }

    const dropped = facts.streams.find((stream) => stream !== video && stream.type !== "audio");

    if (dropped) {
        return `has ${droppedStream(dropped)} that a re-encode would drop`;
    }

    return null;
}

export function savingPercent({ inputBytes, outputBytes }: { inputBytes: number; outputBytes: number }): number {
    return inputBytes <= 0 ? 0 : ((inputBytes - outputBytes) / inputBytes) * 100;
}

export interface OutputVerdict {
    keep: boolean;
    reason: string;
}

/** Whether a finished output replaces the input; every check must pass. `decodeErrors` is what the decode check printed. */
export function judgeOutput({
    input,
    output,
    encoder,
    minSavingPct,
    decodeErrors,
}: {
    input: MediaFacts;
    output: MediaFacts;
    encoder: VideoEncoder;
    minSavingPct: number;
    decodeErrors: string;
}): OutputVerdict {
    const saving = savingPercent({ inputBytes: input.bytes, outputBytes: output.bytes });

    if (saving < minSavingPct) {
        return { keep: false, reason: `only ${saving.toFixed(1)}% smaller, the minimum is ${minSavingPct}%` };
    }

    if (input.durationSec === null || output.durationSec === null) {
        return { keep: false, reason: "a duration is missing" };
    }

    const drift = Math.abs(input.durationSec - output.durationSec);

    if (drift > DURATION_TOLERANCE_SEC) {
        return { keep: false, reason: `duration differs by ${drift.toFixed(2)} s` };
    }

    if (primaryVideo(output)?.codec !== encoder.streamCodec) {
        return { keep: false, reason: `the output video is not ${encoder.codec}` };
    }

    if (hasAudio(input) && !hasAudio(output)) {
        return { keep: false, reason: "the output lost its audio" };
    }

    if (audioStreamCount(output) < audioStreamCount(input)) {
        return {
            keep: false,
            reason: `the output has ${audioStreamCount(output)} of the input's ${audioStreamCount(input)} audio tracks`,
        };
    }

    if (decodeErrors.trim() !== "") {
        return { keep: false, reason: `the output does not decode cleanly: ${decodeErrors.trim().slice(0, 200)}` };
    }

    return { keep: true, reason: `${saving.toFixed(1)}% smaller` };
}

/**
 * The streams a re-encode carries over: the first playable video (`0:V:0`, never a cover picture, the stream
 * `skipReason` judged) and every audio track. The decode check maps the same ones, so it decodes each kept track.
 */
const KEPT_STREAMS = ["-map", "0:V:0", "-map", "0:a?"] as const;

/**
 * The ffmpeg command line, under `nice`; the output keeps the input's container. `-n` refuses to write over an
 * existing file.
 */
export function encodeArgs({
    encoder,
    input,
    output,
    rate,
    height,
    progress = false,
    pass,
    audio = COPY_AUDIO,
}: {
    encoder: VideoEncoder;
    input: string;
    output: string;
    rate: VideoRate;
    /** Scale to this height (the encoder's `scale` decides how); undefined keeps the size. */
    height?: number;
    /** Write `key=value` progress blocks to stdout, for `ffmpegProgressReader`. */
    progress?: boolean;
    /** One run of a two-pass encode; pass 1 writes only its statistics, to the null muxer. */
    pass?: EncodePass;
    audio?: AudioPlan;
}): string[] {
    return ffmpegCommand([
        "-nostdin",
        "-n",
        "-v",
        "error",
        ...(progress ? ["-progress", "pipe:1", "-nostats"] : []),
        ...(height === undefined ? encoder.decodeArgs : encoder.scale.decodeArgs),
        "-i",
        input,
        ...KEPT_STREAMS,
        "-map_metadata",
        "0",
        ...(height === undefined ? [] : ["-vf", encoder.scale.filter(height)]),
        ...encoder.videoArgs(rate, pass),
        ...(pass?.index === 1
            ? ["-an", "-f", "null", "-"]
            : [...audioArgs(audio), "-movflags", "+faststart+use_metadata_tags", output]),
    ]);
}

/**
 * Decodes the whole file and returns what ffmpeg printed; empty means clean. Without the maps ffmpeg would decode one
 * audio track of its own choosing, and a damaged second track would pass.
 */
export async function decodeErrors({
    encoder,
    path,
    signal,
}: {
    encoder: VideoEncoder;
    path: string;
    signal?: AbortSignal;
}): Promise<string> {
    const result = await boundedCommand({
        command: ffmpegCommand([
            "-v",
            "error",
            "-xerror",
            ...encoder.decodeArgs,
            "-i",
            path,
            ...KEPT_STREAMS,
            "-f",
            "null",
            "-",
        ]),
        timeoutMs: 30 * 60_000,
        signal,
    });

    if (result.error) {
        return result.error.message;
    }

    if (result.status !== 0 && result.stderr.trim() === "") {
        return `ffmpeg exited ${result.status}`;
    }

    return result.stderr;
}

/** An audio track whose container records no bitrate counts as this much toward a size target. */
const UNKNOWN_AUDIO_BPS = 128_000;
/** The share of a size target kept for the container (moov atom, interleaving). */
const CONTAINER_SHARE = 0.01;
/** A video rate below this is not worth encoding; the target is too small for the duration. */
export const MIN_TARGET_VIDEO_KBPS = 80;

/** Re-encoded audio at this rate per track is plenty for speech and keeps music acceptable. */
export const AUTO_AUDIO_KBPS = 96;
/** `auto` re-encodes the audio when the copied tracks would take more than this share of a size target. */
const AUDIO_SHARE_LIMIT = 0.15;

/** Reads `--audio`: `auto`, `copy`, or a bitrate in kbit/s (`96`, `96k`). */
export function parseAudioRequest(value: string, flag = "--audio"): AudioRequest {
    if (value === "auto" || value === "copy") {
        return value;
    }

    const kbps = Number(value.replace(/k$/i, ""));

    if (!Number.isInteger(kbps) || kbps < 16 || kbps > 512) {
        throw new Error(
            `${flag} takes auto, copy or an AAC bitrate in kbit/s from 16 to 512 (96, 128k), not "${value}".`
        );
    }

    return kbps;
}

function audioArgs(plan: AudioPlan): string[] {
    return plan.kind === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", `${plan.kbps}k`];
}

/**
 * The audio plan for one file. `auto` copies, except under a size target where the copied tracks would take more than
 * 15% of it and run above 96 kbit/s: then AAC at 96 kbit/s leaves the video more bits (a 128 kbit/s track is 26% of a
 * 400 MB, 108 min file).
 */
export function planAudio({
    facts,
    request,
    targetBytes,
}: {
    facts: MediaFacts;
    request: AudioRequest;
    targetBytes?: number;
}): AudioPlan {
    if (typeof request === "number") {
        return { kind: "aac", kbps: request };
    }

    if (request === "copy" || targetBytes === undefined || !hasAudio(facts)) {
        return COPY_AUDIO;
    }

    const audio = facts.streams.filter((stream) => stream.type === "audio");
    const aboveAuto = audio.every((stream) => (stream.bitRate ?? UNKNOWN_AUDIO_BPS) > AUTO_AUDIO_KBPS * 1000);
    const share = audioBytes(facts) / targetBytes;
    return aboveAuto && share > AUDIO_SHARE_LIMIT ? { kind: "aac", kbps: AUTO_AUDIO_KBPS } : COPY_AUDIO;
}

/** Bytes the audio tracks take over the whole duration, copied (the default) or re-encoded by `plan`. */
export function audioBytes(facts: MediaFacts, plan: AudioPlan = COPY_AUDIO): number {
    const bitsPerSec = facts.streams
        .filter((stream) => stream.type === "audio")
        .reduce(
            (sum, stream) => sum + (plan.kind === "aac" ? plan.kbps * 1000 : (stream.bitRate ?? UNKNOWN_AUDIO_BPS)),
            0
        );
    return ((facts.durationSec ?? 0) * bitsPerSec) / 8;
}

/** The video bitrate that fills `targetBytes` next to the audio, or null without a duration. */
export function videoKbpsForTarget({
    facts,
    targetBytes,
    audio = COPY_AUDIO,
}: {
    facts: MediaFacts;
    targetBytes: number;
    audio?: AudioPlan;
}): number | null {
    if (!facts.durationSec || facts.durationSec <= 0) {
        return null;
    }

    const videoBytes = targetBytes * (1 - CONTAINER_SHARE) - audioBytes(facts, audio);
    return Math.floor((videoBytes * 8) / facts.durationSec / 1000);
}

/** A size within this band of the target needs no corrected pass. */
export const TARGET_BAND = { low: 0.9, high: 1.03 } as const;
/** Corrected passes after the first, when a size-target output lands outside `TARGET_BAND`. */
export const MAX_SIZE_CORRECTIONS = 2;

/**
 * The rate for the next pass, scaled by how far the video part of the last output missed its share of the target;
 * null when the last output is inside `TARGET_BAND`.
 */
export function correctedKbps({
    kbps,
    targetBytes,
    outputBytes,
    audio,
}: {
    kbps: number;
    targetBytes: number;
    outputBytes: number;
    /** The audio bytes inside both sizes. */
    audio: number;
}): number | null {
    const ratio = outputBytes / targetBytes;

    if (ratio >= TARGET_BAND.low && ratio <= TARGET_BAND.high) {
        return null;
    }

    const wantedVideo = targetBytes * (1 - CONTAINER_SHARE) - audio;
    const gotVideo = Math.max(1, outputBytes - audio);
    return Math.max(1, Math.floor((kbps * wantedVideo) / gotVideo));
}
