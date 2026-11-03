import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { runVideoCommand, VideoCommandExitError } from "./process";

export interface MediaStream {
    type: string;
    codec: string;
    /** A cover picture stored as a video stream; it is not a playable video. */
    attachedPicture: boolean;
    /** Pixel size of a video stream, when ffprobe reports it. */
    width?: number;
    height?: number;
    /** Frames per second of a video stream (`r_frame_rate`), when ffprobe reports a usable one. */
    frameRate?: number;
    /** Bits per second, when the container records it. */
    bitRate?: number;
}

export interface MediaFacts {
    path: string;
    bytes: number;
    durationSec: number | null;
    streams: MediaStream[];
}

const ffprobeSchema = z.object({
    streams: z
        .array(
            z.object({
                codec_type: z.string().optional(),
                codec_name: z.string().optional(),
                width: z.number().optional(),
                height: z.number().optional(),
                r_frame_rate: z.string().optional(),
                bit_rate: z.string().optional(),
                disposition: z.object({ attached_pic: z.number().optional() }).optional(),
            })
        )
        .default([]),
    format: z.object({ duration: z.string().optional() }).optional(),
});

/** `25/1` or `30000/1001` as a number; ffprobe prints `0/0` for a stream without a rate. */
function parseFrameRate(value: string | undefined): number | undefined {
    const [num, den] = (value ?? "").split("/").map(Number);
    const rate = den ? num / den : Number.NaN;
    return Number.isFinite(rate) && rate > 0 && rate < 1000 ? rate : undefined;
}

/** Turns the JSON `ffprobe -show_streams -show_format -of json` prints into facts. */
export function parseMediaFacts({ raw, path, bytes }: { raw: unknown; path: string; bytes: number }): MediaFacts {
    const data = ffprobeSchema.parse(raw);
    const duration = data.format?.duration === undefined ? Number.NaN : Number(data.format.duration);

    return {
        path,
        bytes,
        durationSec: Number.isFinite(duration) ? duration : null,
        streams: data.streams.map((stream) => ({
            type: stream.codec_type ?? "unknown",
            codec: stream.codec_name ?? "unknown",
            attachedPicture: (stream.disposition?.attached_pic ?? 0) === 1,
            width: stream.width,
            height: stream.height,
            frameRate: parseFrameRate(stream.r_frame_rate),
            bitRate:
                stream.bit_rate === undefined || !Number.isFinite(Number(stream.bit_rate))
                    ? undefined
                    : Number(stream.bit_rate),
        })),
    };
}

/** The first stream that is a real video (a cover picture does not count). */
export function primaryVideo(facts: MediaFacts): MediaStream | null {
    return facts.streams.find((stream) => stream.type === "video" && !stream.attachedPicture) ?? null;
}

export function hasAudio(facts: MediaFacts): boolean {
    return audioStreamCount(facts) > 0;
}

export function audioStreamCount(facts: MediaFacts): number {
    return facts.streams.filter((stream) => stream.type === "audio").length;
}

/**
 * ffprobe ran on a readable file and exited non-zero: the file is not media it can read. Every other failure of
 * `readMediaFacts` (a missing or unreadable file, no ffprobe, a timeout, a cancel) throws as it is, so a caller can
 * tell "not a video" from a probe that never ran.
 */
export class NotMediaError extends Error {
    constructor(path: string, cause: VideoCommandExitError) {
        super(`ffprobe cannot read ${path} as media: ${cause.message.trim()}`, { cause });
        this.name = "NotMediaError";
    }
}

/** Reads container and stream facts of any media file; no size or duration limit, unlike `probeVideo`. */
export async function readMediaFacts({ input, signal }: { input: string; signal?: AbortSignal }): Promise<MediaFacts> {
    const path = resolve(input);
    // Opened, not only stat'ed: a file this process cannot read fails here, before ffprobe could call it "not media".
    const handle = await open(path, "r");
    const bytes = await handle
        .stat()
        .then((stat) => stat.size)
        .finally(() => handle.close());
    let raw: string;

    try {
        raw = await runVideoCommand({
            command: ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
            signal,
            timeoutMs: 60_000,
        });
    } catch (error) {
        if (error instanceof VideoCommandExitError) {
            throw new NotMediaError(path, error);
        }

        throw error;
    }

    return parseMediaFacts({ raw: SafeJSON.parse(raw, { strict: true }), path, bytes });
}
