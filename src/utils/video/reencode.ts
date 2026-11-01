import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { hasAudio, type MediaFacts, primaryVideo } from "./media-facts";

/** A re-encode target. Add a codec by adding one entry to `VIDEO_ENCODERS`; no call site branches on the name. */
export interface VideoEncoder {
    codec: string;
    /** The ffmpeg encoder name, e.g. `hevc_videotoolbox`. */
    ffmpegName: string;
    /** What ffprobe calls the codec of a stream this encoder wrote. */
    streamCodec: string;
    defaultQuality: number;
    /** Containers that can hold this codec, by extension with the dot. */
    containers: readonly string[];
    /** Platforms the encoder runs on (`process.platform` values). */
    platforms: readonly NodeJS.Platform[];
    /** Hardware decode flags, also used to verify the output. */
    decodeArgs: readonly string[];
    /** The video part of the ffmpeg command line. */
    videoArgs: (quality: number) => string[];
}

export const VIDEO_ENCODERS = {
    hevc: {
        codec: "hevc",
        ffmpegName: "hevc_videotoolbox",
        streamCodec: "hevc",
        defaultQuality: 58,
        containers: [".mp4", ".m4v", ".mov", ".mkv"],
        platforms: ["darwin"],
        decodeArgs: ["-hwaccel", "videotoolbox"],
        videoArgs: (quality) => ["-c:v", "hevc_videotoolbox", "-q:v", String(quality), "-tag:v", "hvc1"],
    },
} as const satisfies Record<string, VideoEncoder>;

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

/** Why an input is not re-encoded, or null when it is a candidate. */
export function skipReason({ facts, encoder }: { facts: MediaFacts; encoder: VideoEncoder }): string | null {
    const video = primaryVideo(facts);

    if (!video) {
        return "not a video (no video stream)";
    }

    if (video.codec === encoder.streamCodec) {
        return `already ${encoder.codec}`;
    }

    const data = facts.streams.find((stream) => stream.type === "data");

    if (data) {
        return `has a data track (${data.codec}) that a re-encode would drop`;
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

    if (decodeErrors.trim() !== "") {
        return { keep: false, reason: `the output does not decode cleanly: ${decodeErrors.trim().slice(0, 200)}` };
    }

    return { keep: true, reason: `${saving.toFixed(1)}% smaller` };
}

/**
 * The ffmpeg command line, under `nice`; the output keeps the input's container. `-n` refuses to write over an
 * existing file, and `0:V:0` is the first playable video, never a cover picture (the stream `skipReason` judged).
 */
export function encodeArgs({
    encoder,
    input,
    output,
    quality,
}: {
    encoder: VideoEncoder;
    input: string;
    output: string;
    quality: number;
}): string[] {
    return ffmpegCommand([
        "-nostdin",
        "-n",
        "-v",
        "error",
        ...encoder.decodeArgs,
        "-i",
        input,
        "-map",
        "0:V:0",
        "-map",
        "0:a?",
        "-map_metadata",
        "0",
        ...encoder.videoArgs(quality),
        "-c:a",
        "copy",
        "-movflags",
        "+faststart+use_metadata_tags",
        output,
    ]);
}

/** Decodes the whole file and returns what ffmpeg printed; empty means clean. */
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
        command: ffmpegCommand(["-v", "error", "-xerror", ...encoder.decodeArgs, "-i", path, "-f", "null", "-"]),
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
