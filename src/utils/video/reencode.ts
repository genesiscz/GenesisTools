import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { audioStreamCount, hasAudio, type MediaFacts, type MediaStream, primaryVideo } from "./media-facts";

/** How the encoder spends bits: a constant quality, or an average bitrate that a size target asks for. */
export type VideoRate = { kind: "quality"; quality: number } | { kind: "bitrate"; kbps: number };

/** One run of a two-pass encode: pass 1 only writes the statistics file that pass 2 reads. */
export interface EncodePass {
    index: 1 | 2;
    /** The statistics file prefix both passes share. */
    logFile: string;
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
        // -qmax 36 (no frame coarser than QP 36) 0.982 at 395. -spatial_aq 1 changed nothing on an M4 Max. The rate can
        // still miss, which the size-target loop corrects.
        videoArgs: (rate) => [
            "-c:v",
            "hevc_videotoolbox",
            ...(rate.kind === "quality" ? ["-q:v", String(rate.quality)] : ["-b:v", `${rate.kbps}k`, "-qmax", "36"]),
            ...LONG_GOP,
            "-bf",
            "2",
            "-prio_speed",
            "0",
            "-tag:v",
            "hvc1",
        ],
        // Decode, scale and encode all stay on the GPU: 0.7 s of user CPU for 2 min of 1080p, against 11 s with the
        // software scaler (measured 2026-11-02).
        scale: {
            decodeArgs: ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"],
            filter: (height) => `scale_vt=w=-2:h=${height}`,
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
        label: "HEVC on the CPU (x265 slow): the same quality as x264 here, about five times slower",
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
            "slow",
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
}: {
    encoder: VideoEncoder;
    input: string;
    output: string;
    rate: VideoRate;
    /** Scale to this height on the GPU; undefined keeps the size. */
    height?: number;
    /** Write `key=value` progress blocks to stdout, for `ffmpegProgressReader`. */
    progress?: boolean;
    /** One run of a two-pass encode; pass 1 writes only its statistics, to the null muxer. */
    pass?: EncodePass;
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
            : ["-c:a", "copy", "-movflags", "+faststart+use_metadata_tags", output]),
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

/** Bytes the copied audio tracks take over the whole duration. */
export function audioBytes(facts: MediaFacts): number {
    const bitsPerSec = facts.streams
        .filter((stream) => stream.type === "audio")
        .reduce((sum, stream) => sum + (stream.bitRate ?? UNKNOWN_AUDIO_BPS), 0);
    return ((facts.durationSec ?? 0) * bitsPerSec) / 8;
}

/** The video bitrate that fills `targetBytes` next to the copied audio, or null without a duration. */
export function videoKbpsForTarget({ facts, targetBytes }: { facts: MediaFacts; targetBytes: number }): number | null {
    if (!facts.durationSec || facts.durationSec <= 0) {
        return null;
    }

    const videoBytes = targetBytes * (1 - CONTAINER_SHARE) - audioBytes(facts);
    return Math.floor((videoBytes * 8) / facts.durationSec / 1000);
}

/** A size within this band of the target needs no corrected pass. */
export const TARGET_BAND = { low: 0.9, high: 1.03 } as const;

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
