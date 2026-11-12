import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { measureAudio } from "./measure";
import { encodeMidi } from "./midi";
import { publishAudio, runAudio, withMusicScratch } from "./process";
import { soundfontPaths, verifySoundfont } from "./soundfont";
import { type AudioMeasurement, type Score, scoreSchema } from "./types";

export function fluidSynthArgs(options: { soundfont: string; midi: string; raw: string }): string[] {
    return [
        "-n",
        "-i",
        "-q",
        "-F",
        options.raw,
        "-T",
        "wav",
        "-O",
        "float",
        "-r",
        "48000",
        "-g",
        "0.5",
        "-R",
        "0",
        "-C",
        "0",
        "-o",
        "synth.cpu-cores=1",
        "-o",
        "player.timing-source=sample",
        options.soundfont,
        options.midi,
    ];
}

export function audioCodec(output: string): string[] {
    const extension = extname(output).toLowerCase();

    if (extension === ".wav") {
        return ["-f", "wav", "-c:a", "pcm_s16le"];
    }

    if (extension === ".m4a") {
        return ["-f", "ipod", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
    }

    throw new Error("Music output must end in .wav or .m4a");
}

export async function renderScore(options: {
    score: Score;
    output: string;
    soundfont?: string;
    targetLufs?: number;
    peakDb?: number;
    overwrite?: boolean;
}): Promise<{
    measurement: AudioMeasurement;
    scoreSha256: string;
    soundfontSha256: string;
    renderer: string;
    encoder: string;
    targetLufs: number;
}> {
    const score = scoreSchema.parse(options.score);
    const targetLufs = options.targetLufs ?? -20;
    const peakDb = options.peakDb ?? -3;

    if (
        !Number.isFinite(targetLufs) ||
        targetLufs < -36 ||
        targetLufs > -14 ||
        !Number.isFinite(peakDb) ||
        peakDb < -12 ||
        peakDb > -1
    ) {
        throw new Error("Target must be -36 to -14 LUFS and true-peak cap -12 to -1 dBTP");
    }

    const codec = audioCodec(options.output);
    const soundfont = resolve(options.soundfont ?? soundfontPaths().file);
    const soundfontSha256 = await verifySoundfont(soundfont);
    const [fluidVersion, ffmpegVersion] = await Promise.all([
        runAudio(["fluidsynth", "--version"]),
        runAudio(["ffmpeg", "-version"]),
    ]);
    let result: AudioMeasurement | undefined;

    await withMusicScratch(async (folder) => {
        const midi = join(folder, "score.mid");
        const raw = join(folder, "raw.wav");
        await writeFile(midi, encodeMidi(score));
        await runAudio(["fluidsynth", ...fluidSynthArgs({ soundfont, midi, raw })]);
        const measured = await measureAudio(raw);
        const gainDb = targetLufs - measured.lufs;

        if (measured.truePeakDb + gainDb > peakDb) {
            throw new Error("Score crest factor exceeds the peak cap at target LUFS; reduce the loudest instrument");
        }

        await publishAudio({
            output: options.output,
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
                    raw,
                    "-af",
                    `atrim=duration=${score.seconds},volume=${gainDb.toFixed(6)}dB`,
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-map_metadata",
                    "-1",
                    "-fflags",
                    "+bitexact",
                    "-flags:a",
                    "+bitexact",
                    "-threads",
                    "1",
                    ...codec,
                    temporary,
                ]);
                result = await measureAudio(temporary);

                if (Math.abs(result.lufs - targetLufs) > 0.35 || result.truePeakDb > peakDb + 0.1) {
                    throw new Error("Mastered output misses LUFS target or true-peak cap");
                }
            },
        });
    });

    if (!result) {
        throw new Error("Renderer produced no measurement");
    }

    return {
        measurement: { ...result, file: resolve(options.output) },
        scoreSha256: createHash("sha256").update(SafeJSON.stringify(score)).digest("hex"),
        soundfontSha256,
        renderer: fluidVersion.stdout.split("\n")[0],
        encoder: ffmpegVersion.stdout.split("\n")[0],
        targetLufs,
    };
}
