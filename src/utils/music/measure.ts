import { resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { fileHash, runAudio } from "./process";
import type { AudioMeasurement } from "./types";

const probeSchema = z.object({
    streams: z.array(z.object({ codec_type: z.string().optional(), duration: z.unknown().optional() })).default([]),
    format: z.object({ duration: z.coerce.number().finite().positive() }),
});

export async function probeMedia(file: string): Promise<{ seconds: number; audio: boolean; video: boolean }> {
    const { stdout } = await runAudio([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,duration",
        "-of",
        "json",
        resolve(file),
    ]);
    const data = probeSchema.parse(SafeJSON.parse(stdout, { strict: true }));
    const selected =
        data.streams.find((stream) => stream.codec_type === "video") ??
        data.streams.find((stream) => stream.codec_type === "audio");
    const duration = Number(selected?.duration);
    return {
        seconds: Number.isFinite(duration) && duration > 0 ? duration : data.format.duration,
        audio: data.streams.some((stream) => stream.codec_type === "audio"),
        video: data.streams.some((stream) => stream.codec_type === "video"),
    };
}

export function parseLoudness(stderr: string): { lufs: number; truePeakDb: number } {
    const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);

    if (!match) {
        throw new Error("ffmpeg did not report integrated loudness");
    }

    const data = z
        .object({ input_i: z.coerce.number().finite(), input_tp: z.coerce.number().finite() })
        .parse(SafeJSON.parse(match, { strict: true }));
    return { lufs: data.input_i, truePeakDb: data.input_tp };
}

function rms(stderr: string): number | null {
    const match = /mean_volume:\s*(-?inf|[-\d.]+) dB/.exec(stderr);

    if (!match) {
        throw new Error("ffmpeg did not report a band level");
    }

    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

export async function measureAudio(file: string): Promise<AudioMeasurement> {
    const source = resolve(file);
    const bands = ["lowpass=f=110", "highpass=f=110,lowpass=f=2000", "highpass=f=2000"];
    const [probe, full, levels, sha256] = await Promise.all([
        probeMedia(source),
        runAudio([
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-i",
            source,
            "-vn",
            "-af",
            "loudnorm=I=-20:TP=-3:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
        ]),
        Promise.all(
            bands.map((filter) =>
                runAudio([
                    "ffmpeg",
                    "-hide_banner",
                    "-nostdin",
                    "-i",
                    source,
                    "-vn",
                    "-af",
                    `${filter},volumedetect`,
                    "-f",
                    "null",
                    "-",
                ])
            )
        ),
        fileHash(source),
    ]);

    if (!probe.audio) {
        throw new Error(`No audio stream: ${source}`);
    }

    return {
        file: source,
        seconds: probe.seconds,
        ...parseLoudness(full.stderr),
        rmsDb: { low: rms(levels[0].stderr), mid: rms(levels[1].stderr), high: rms(levels[2].stderr) },
        sha256,
    };
}
