import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";

const { log } = logger.scoped("recording-editor-denoise");

/**
 * Noise reduction of a movie's sound on export. The export renderer (AVFoundation) cannot run ffmpeg filters, so the
 * export renders from a copy of the source whose chosen audio tracks went through the filter (`.denoise/` beside the
 * source, made once per source and settings). The picture is copied, not encoded again.
 */

/** `afftdn`: ffmpeg's FFT denoiser, which learns the noise floor itself; no model file. */
export const DENOISE_METHODS = ["afftdn"] as const;
export type DenoiseMethod = (typeof DENOISE_METHODS)[number];

export const denoiseSchema = z.object({
    method: z.enum(DENOISE_METHODS).default("afftdn"),
    /** How much the noise is turned down, in dB (afftdn `nr`). 12 takes fan and room hum away; 25+ starts to blur words. */
    reductionDb: z.number().min(1).max(40).default(12),
    /** The audio tracks to clean (0 is the first); absent is every track. A screen recording's mic is its last track. */
    tracks: z.array(z.number().int().nonnegative()).optional(),
});
export type DenoiseSettings = z.infer<typeof denoiseSchema>;

const DENOISE_FILTERS: Record<DenoiseMethod, (settings: DenoiseSettings) => string> = {
    // nf: the noise floor it starts from (dB); tn: it keeps tracking the noise, which suits a room that changes.
    afftdn: (settings) => `afftdn=nr=${settings.reductionDb}:nf=-50:tn=1`,
};

export function denoiseFilter(settings: DenoiseSettings): string {
    return DENOISE_FILTERS[settings.method](settings);
}

/** The ffmpeg command that copies the picture and cleans the chosen audio tracks (the others are copied). */
export function denoisedSourceArgv(options: {
    source: string;
    output: string;
    audioTracks: number;
    settings: DenoiseSettings;
}): string[] {
    const { audioTracks, settings } = options;
    const cleaned = new Set(settings.tracks ?? [...Array(audioTracks).keys()]);
    const perTrack = [...Array(audioTracks).keys()].flatMap((track) =>
        cleaned.has(track)
            ? [`-filter:a:${track}`, denoiseFilter(settings), `-c:a:${track}`, "aac", `-b:a:${track}`, "192k"]
            : [`-c:a:${track}`, "copy"]
    );
    return [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        options.source,
        "-map",
        "0:v?",
        "-map",
        "0:a?",
        "-c:v",
        "copy",
        ...perTrack,
        "-movflags",
        "+faststart",
        options.output,
    ];
}

async function audioTrackCount(source: string): Promise<number> {
    const stdout = await runVideoCommand({
        command: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            source,
        ],
        timeoutMs: 30_000,
    });
    return stdout.split("\n").filter((line) => line.trim()).length;
}

/** `.denoise/<stem>-<hash>.mp4` beside the source: the hash covers the source's size and time and the settings. */
export function denoisedSourcePath(source: string, settings: DenoiseSettings): string {
    const stat = statSync(source);
    const key = createHash("sha256")
        .update(SafeJSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs, settings }))
        .digest("hex")
        .slice(0, 12);
    return join(dirname(source), ".denoise", `${basename(source, extname(source))}-${key}.mp4`);
}

/** The cleaned copy of `source`, made when it does not exist yet. Throws when the source has no audio. */
export async function ensureDenoisedSource(options: {
    source: string;
    settings: DenoiseSettings;
    signal?: AbortSignal;
}): Promise<{ path: string; made: boolean; audioTracks: number }> {
    const output = denoisedSourcePath(options.source, options.settings);
    const audioTracks = await audioTrackCount(options.source);

    if (audioTracks === 0) {
        throw new Error(`${options.source} has no sound to clean`);
    }

    if (existsSync(output)) {
        return { path: output, made: false, audioTracks };
    }

    mkdirSync(dirname(output), { recursive: true });
    const partial = `${output.slice(0, -4)}.partial.mp4`;
    const command = denoisedSourceArgv({
        source: options.source,
        output: partial,
        audioTracks,
        settings: options.settings,
    });
    log.info({ source: options.source, output, settings: options.settings, audioTracks }, "cleaning the sound");
    await runVideoCommand({ command, timeoutMs: 60 * 60_000, ...(options.signal ? { signal: options.signal } : {}) });
    renameSync(partial, output);
    return { path: output, made: true, audioTracks };
}
