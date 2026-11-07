import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { runVideoCommand } from "./process";
import { secondsToMicroseconds, signedSecondsToMicroseconds } from "./sampling";
import type { VideoInfo } from "./types";

const probeSchema = z.object({
    streams: z
        .array(
            z.object({
                width: z.number().int().positive(),
                height: z.number().int().positive(),
                duration: z.string().optional(),
                codec_name: z.string().optional(),
                color_space: z.string().optional(),
                color_transfer: z.string().optional(),
                side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
            })
        )
        .min(1),
    format: z.object({ duration: z.string().optional() }).optional(),
});

/** The evidence pipeline's limits; the recording editor passes its own (a meeting runs an hour). */
export const VIDEO_PROBE_LIMITS = { maxBytes: 1024 * 1024 * 1024, maxDurationUs: 600_000_000, maxPixels: 48_000_000 };
export type VideoProbeLimits = typeof VIDEO_PROBE_LIMITS;

export async function probeVideo({
    input,
    signal,
    limits = VIDEO_PROBE_LIMITS,
}: {
    input: string;
    signal?: AbortSignal;
    limits?: VideoProbeLimits;
}): Promise<VideoInfo> {
    const path = resolve(input);
    const file = await stat(path);
    if (file.isFile() && file.size === 0) {
        throw new Error(`${path} is empty (0 bytes): the recording wrote no movie`);
    }

    if (!file.isFile() || file.size > limits.maxBytes) {
        throw new Error(`Choose a local video file up to ${Math.round(limits.maxBytes / 1024 ** 3)} GiB`);
    }

    let raw: string;
    try {
        raw = await runVideoCommand({
            command: [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                path,
            ],
            signal,
            timeoutMs: 30_000,
        });
    } catch (error) {
        signal?.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        // ffprobe names the file in every line; the last line without it is the reason ("moov atom not found").
        const lines = reason
            .split("\n")
            .map((line) =>
                line
                    .replace(/^\[[^\]]*\]\s*/, "")
                    .replace(`${path}: `, "")
                    .trim()
            )
            .filter(Boolean);
        const why = lines.find((line) => /moov atom not found/i.test(line)) ?? lines.at(-1) ?? reason;
        const unfinished = /moov atom not found/i.test(reason) ? "; a recording that did not finish has no index" : "";
        throw new Error(`${path} is not a movie ffprobe can read (${why})${unfinished}`);
    }
    const data = probeSchema.parse(SafeJSON.parse(raw, { strict: true }));
    const video = data.streams[0];
    const durationUs = secondsToMicroseconds(video.duration ?? data.format?.duration ?? "");
    if (durationUs <= 0 || durationUs > limits.maxDurationUs || video.width * video.height > limits.maxPixels) {
        throw new Error(
            `Video exceeds the ${Math.round(limits.maxDurationUs / 60_000_000)}-minute or ${Math.round(limits.maxPixels / 1_000_000)}-megapixel limit`
        );
    }

    if (video.color_transfer === "smpte2084" || video.color_transfer === "arib-std-b67") {
        throw new Error("HDR evidence needs an explicit SDR conversion; export an SDR copy before splitting");
    }

    const rotation =
        (((video.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ?? 0) % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(rotation)) {
        throw new Error("Unsupported video rotation; normalize the source before splitting");
    }

    const portrait = rotation === 90 || rotation === 270;
    return {
        path,
        durationUs,
        width: video.width,
        height: video.height,
        displayWidth: portrait ? video.height : video.width,
        displayHeight: portrait ? video.width : video.height,
        rotation,
        bytes: file.size,
        codec: video.codec_name ?? "unknown",
        colorSpace: video.color_space,
        colorTransfer: video.color_transfer,
    };
}

export async function readVideoFrameTimes({
    input,
    signal,
}: {
    input: string;
    signal?: AbortSignal;
}): Promise<number[]> {
    const raw = await runVideoCommand({
        command: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
            resolve(input),
        ],
        signal,
    });
    const data = z
        .object({
            frames: z
                .array(z.object({ best_effort_timestamp_time: z.string() }))
                .min(1)
                .max(180_000),
        })
        .parse(SafeJSON.parse(raw, { strict: true }));
    const absolute = data.frames.map((frame) => signedSecondsToMicroseconds(frame.best_effort_timestamp_time));
    const start = absolute[0];
    return absolute.map((time) => time - start);
}
