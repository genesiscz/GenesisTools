import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { runVideoCommand } from "./process";

export interface MediaStream {
    type: string;
    codec: string;
    /** A cover picture stored as a video stream; it is not a playable video. */
    attachedPicture: boolean;
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
                disposition: z.object({ attached_pic: z.number().optional() }).optional(),
            })
        )
        .default([]),
    format: z.object({ duration: z.string().optional() }).optional(),
});

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
        })),
    };
}

/** The first stream that is a real video (a cover picture does not count). */
export function primaryVideo(facts: MediaFacts): MediaStream | null {
    return facts.streams.find((stream) => stream.type === "video" && !stream.attachedPicture) ?? null;
}

export function hasAudio(facts: MediaFacts): boolean {
    return facts.streams.some((stream) => stream.type === "audio");
}

/** Reads container and stream facts of any media file; no size or duration limit, unlike `probeVideo`. */
export async function readMediaFacts({ input, signal }: { input: string; signal?: AbortSignal }): Promise<MediaFacts> {
    const path = resolve(input);
    const file = await stat(path);
    const raw = await runVideoCommand({
        command: ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        signal,
        timeoutMs: 60_000,
    });

    return parseMediaFacts({ raw: SafeJSON.parse(raw, { strict: true }), path, bytes: file.size });
}
