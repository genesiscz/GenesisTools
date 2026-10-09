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

export async function probeVideo({ input, signal }: { input: string; signal?: AbortSignal }): Promise<VideoInfo> {
    const path = resolve(input);
    const file = await stat(path);
    if (!file.isFile() || file.size <= 0 || file.size > 1024 * 1024 * 1024) {
        throw new Error("Choose a local video file up to 1 GiB");
    }

    const raw = await runVideoCommand({
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
    const data = probeSchema.parse(SafeJSON.parse(raw, { strict: true }));
    const video = data.streams[0];
    const durationUs = secondsToMicroseconds(video.duration ?? data.format?.duration ?? "");
    if (durationUs <= 0 || durationUs > 600_000_000 || video.width * video.height > 48_000_000) {
        throw new Error("Video exceeds the 10-minute or 48-megapixel limit");
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
