import { resolve } from "node:path";
import { z } from "zod";
import { probeMedia } from "./measure";
import { publishAudio, runAudio } from "./process";
import type { MixOptions, Placement } from "./types";

const positive = z.number().finite().positive();
const mixSchema = z.object({
    video: z.string().min(1),
    music: z.string().min(1),
    output: z.string().min(1),
    end: positive,
    volume: z.number().finite().min(0).max(2).default(0.6),
    fadeIn: z.number().finite().min(0).max(60).default(1.5),
    fadeOut: z.number().finite().min(0).max(60).default(3),
    duck: z.boolean().default(true),
    threshold: z.number().finite().min(0.001).max(1).default(0.03),
    ratio: z.number().finite().min(1).max(20).default(4),
    attackMs: z.number().finite().min(0.01).max(2000).default(8),
    releaseMs: z.number().finite().min(0.01).max(9000).default(350),
    overwrite: z.boolean().optional(),
});

export function placeMusic(options: {
    videoSeconds: number;
    musicSeconds: number;
    end: number;
    fadeOut?: number;
}): Placement {
    positive.parse(options.videoSeconds);
    positive.parse(options.musicSeconds);
    positive.parse(options.end);
    const fadeOut = z
        .number()
        .finite()
        .nonnegative()
        .parse(options.fadeOut ?? 3);

    if (options.end > options.musicSeconds + 0.02) {
        throw new Error("Music file ends before its written ending");
    }

    const shift = options.videoSeconds - options.end;
    return {
        trim: Math.max(0, -shift),
        delay: Math.max(0, shift),
        fadeOutAt: Math.max(0, options.videoSeconds - fadeOut),
    };
}

const decimal = (value: number) => String(Number(value.toFixed(6)));

export function musicFilterGraph(
    input: MixOptions & {
        videoSeconds: number;
        musicSeconds: number;
        sourceHasAudio: boolean;
    }
): string {
    const options = mixSchema.parse(input);
    const place = placeMusic({
        videoSeconds: input.videoSeconds,
        musicSeconds: input.musicSeconds,
        end: options.end,
        fadeOut: options.fadeOut,
    });
    const duration = decimal(input.videoSeconds);
    const format = "aformat=sample_rates=48000:channel_layouts=stereo";
    const fades = [
        `atrim=start=${decimal(place.trim)},asetpts=PTS-STARTPTS`,
        `adelay=${Math.round(place.delay * 1000)}:all=1`,
        `apad,atrim=duration=${duration}`,
        ...(options.fadeIn > 0
            ? [
                  "afade=t=in:st=" +
                      decimal(place.delay) +
                      ":d=" +
                      decimal(Math.min(options.fadeIn, input.videoSeconds - place.delay)),
              ]
            : []),
        ...(options.fadeOut > 0
            ? [
                  "afade=t=out:st=" +
                      decimal(place.fadeOutAt) +
                      ":d=" +
                      decimal(Math.min(options.fadeOut, input.videoSeconds)),
              ]
            : []),
        `volume=${decimal(options.volume)}`,
    ];
    const effects = input.sourceHasAudio
        ? `[0:a:0]${format},apad,atrim=duration=${duration}`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${duration}`;
    const chains = [`${effects},asplit=2[effects][key]`, `[1:a:0]${format},${fades.join(",")}[music]`];

    if (options.duck) {
        chains.push(
            "[music][key]sidechaincompress=threshold=" +
                decimal(options.threshold) +
                ":ratio=" +
                decimal(options.ratio) +
                ":attack=" +
                decimal(options.attackMs) +
                ":release=" +
                decimal(options.releaseMs) +
                ":detection=peak[ducked]"
        );
    } else {
        chains.push("[key]anullsink", "[music]anull[ducked]");
    }

    chains.push(
        "[effects][ducked]amix=inputs=2:duration=first:normalize=0," +
            "alimiter=limit=0.79:level=false:latency=true,atrim=duration=" +
            duration +
            "[mix]"
    );
    return chains.join(";");
}

export async function mixMusic(input: MixOptions): Promise<{ output: string; placement: Placement }> {
    const options = mixSchema.parse(input);
    const video = resolve(options.video);
    const music = resolve(options.music);
    const output = resolve(options.output);

    if (output === video || output === music) {
        throw new Error("Mix output must differ from both inputs");
    }

    const [movie, track] = await Promise.all([probeMedia(video), probeMedia(music)]);

    if (!movie.video || !track.audio) {
        throw new Error("Mix needs a video stream and a music audio stream");
    }

    const graph = musicFilterGraph({
        ...options,
        videoSeconds: movie.seconds,
        musicSeconds: track.seconds,
        sourceHasAudio: movie.audio,
    });
    await publishAudio({
        output,
        overwrite: options.overwrite,
        prepare: async (temporary) => {
            await runAudio([
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-i",
                video,
                "-i",
                music,
                "-filter_complex",
                graph,
                "-map",
                "0:v:0",
                "-map",
                "[mix]",
                "-map_metadata",
                "0",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-t",
                decimal(movie.seconds),
                "-fflags",
                "+bitexact",
                "-flags:a",
                "+bitexact",
                "-threads",
                "1",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                temporary,
            ]);
        },
    });
    return {
        output,
        placement: placeMusic({
            videoSeconds: movie.seconds,
            musicSeconds: track.seconds,
            end: options.end,
            fadeOut: options.fadeOut,
        }),
    };
}
