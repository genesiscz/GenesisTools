import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { gain, RATE, type Stereo } from "./dsp";
import { filterPass, scale } from "./effects";
import { fluidSynthArgs } from "./fluidsynth";
import { measureAudio, parseLoudness } from "./measure";
import { encodeMidi } from "./midi";
import { publishAudio, runAudio, withMusicScratch } from "./process";
import { soundfontPaths, verifySoundfont } from "./soundfont";
import { guardLows, limit, softClip } from "./space";
import { mixScore, needsStems, readFloat, writeFloatWav } from "./stems";
import { type AudioMeasurement, MAX_LUFS, MIN_LUFS, type Score, scoreSchema } from "./types";

export { fluidSynthArgs } from "./fluidsynth";

/** Room the limiter leaves under the ceiling at first. A lossy encoder lifts the peaks of limited audio. */
const LIMITER_MARGIN_DB = 1.2;
const LIMITER_ATTEMPTS = 5;
/** Loudness the clipper and the limiter may take away. Past it the bass tears, so a guarded master ships quieter. */
export const MAX_LIMITER_LOSS_DB = 3;
/** How far the low end may stand over the rest of a guarded mix, in dB. */
const LOW_GUARD_DB = 6;
/** Rumble under this frequency moves a speaker and takes headroom, and nobody hears it. */
const RUMBLE_HZ = 25;

/** What the master did to a score with `master.limiter`. */
export interface MasterReport {
    /** Loudness the clipper and the limiter took away, in dB. */
    limiterLossDb: number;
    /** How far under the loudness target the file ships because of the loss cap. 0 when it reached the target. */
    shortOfTargetDb: number;
    /** The deepest cut of the low end by the guard, in dB. */
    lowCutDb: number;
}

class MasterMiss extends Error {
    constructor(
        message: string,
        readonly peakOverDb: number
    ) {
        super(message);
    }
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

async function analyze(file: string, trim: string): Promise<{ lufs: number; truePeakDb: number }> {
    const analysis = await runAudio([
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-i",
        file,
        "-vn",
        "-af",
        `${trim},loudnorm=I=-20:TP=-3:LRA=11:print_format=json`,
        "-f",
        "null",
        "-",
    ]);
    return parseLoudness(analysis.stderr);
}

/**
 * Find the input gain that brings a limited mix to the loudness target. Loudness after limiting is not linear in
 * the gain, so the gain is searched. `limited` applies a gain and answers the loudness that came out. When the
 * limiter would take away more than `maxLossDb`, the search stops at the loudest gain under that loss.
 */
export async function searchBoost(options: {
    beforeLufs: number;
    targetLufs: number;
    maxLossDb: number;
    limited: (boostDb: number) => Promise<number>;
}): Promise<{ boostDb: number; lufs: number; lossDb: number }> {
    const { beforeLufs, targetLufs, maxLossDb } = options;
    let boost = targetLufs - beforeLufs;
    let tooMuch = Number.POSITIVE_INFINITY;
    let best: { boostDb: number; lufs: number; lossDb: number } | undefined;
    let miss = 0;

    for (let pass = 0; pass < 16; pass++) {
        const lufs = await options.limited(boost);
        const lossDb = beforeLufs + boost - lufs;
        miss = targetLufs - lufs;

        if (lossDb > maxLossDb + 0.1) {
            tooMuch = boost;
            boost = best ? (best.boostDb + boost) / 2 : boost - (lossDb - maxLossDb) * 1.3;
            continue;
        }

        if (miss < -0.15) {
            boost += miss;
            continue;
        }

        best = { boostDb: boost, lufs, lossDb };

        if (miss < 0.15 || tooMuch - boost < 0.3) {
            break;
        }

        // Under heavy limiting a dB of input gain adds less than a dB of loudness.
        boost = Number.isFinite(tooMuch) ? (boost + tooMuch) / 2 : boost + miss * 1.5;
    }

    if (!best || (!Number.isFinite(tooMuch) && miss >= 0.3)) {
        throw new Error(`The limiter stays ${miss.toFixed(1)} LU under ${targetLufs} LUFS; lower the loudness target`);
    }

    return best;
}

/**
 * Bring the mix to the loudness target under a sample ceiling: a soft clipper takes the short peaks, a look-ahead
 * limiter the rest. The file holds the limited mix at the gain the search chose.
 */
async function limitToTarget(options: {
    mix: Stereo;
    file: string;
    trim: string;
    targetLufs: number;
    ceilingDb: number;
    clipDb: number;
    maxLossDb: number;
}): Promise<{ lufs: number; lossDb: number }> {
    const { mix, file, trim } = options;
    const ceiling = gain(options.ceilingDb);
    const clipAt = ceiling * gain(options.clipDb);
    let written = Number.NaN;
    const limited = async (boostDb: number) => {
        const copy = { left: mix.left.slice(), right: mix.right.slice() };
        scale(copy, gain(boostDb) / clipAt);
        softClip(copy, 0.6);
        scale(copy, clipAt);
        limit(copy, ceiling);
        await writeFloatWav(file, copy);
        written = boostDb;
        return (await analyze(file, trim)).lufs;
    };
    await writeFloatWav(file, mix);
    const found = await searchBoost({
        beforeLufs: (await analyze(file, trim)).lufs,
        targetLufs: options.targetLufs,
        maxLossDb: options.maxLossDb,
        limited,
    });

    if (written !== found.boostDb) {
        await limited(found.boostDb);
    }

    return found;
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
    master?: MasterReport;
}> {
    const score = scoreSchema.parse(options.score);
    const targetLufs = options.targetLufs ?? score.master?.lufs ?? -20;
    const peakDb = options.peakDb ?? score.master?.peak ?? -3;
    const limiter = score.master?.limiter ?? false;
    const guard = limiter && (score.master?.guard ?? true);
    let report: MasterReport | undefined;

    if (
        !Number.isFinite(targetLufs) ||
        targetLufs < MIN_LUFS ||
        targetLufs > MAX_LUFS ||
        !Number.isFinite(peakDb) ||
        peakDb < -12 ||
        peakDb > -0.5
    ) {
        throw new Error(`Target must be ${MIN_LUFS} to ${MAX_LUFS} LUFS and true-peak cap -12 to -0.5 dBTP`);
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
        const raw = join(folder, "raw.wav");
        const samples = Math.round(score.seconds * RATE);
        let mix: Stereo | undefined;

        if (needsStems(score)) {
            mix = await mixScore({ score, folder, soundfont });
            await writeFloatWav(raw, mix);
        } else {
            const midi = join(folder, "score.mid");
            await writeFile(midi, encodeMidi(score));
            await runAudio(["fluidsynth", ...fluidSynthArgs({ soundfont, midi, raw })]);
        }

        // FluidSynth renders the release tail past the score's end. The gain is measured on what ships, the trimmed
        // audio: measured on the whole render, the trim then moves the integrated loudness off the target. The same
        // atrim runs in the analysis pass and in the mastering pass, so no trimmed copy is written to disk.
        const trim = `atrim=duration=${score.seconds}`;
        const attempts = limiter ? LIMITER_ATTEMPTS : 1;
        let margin = LIMITER_MARGIN_DB;
        let trimDb = 0;

        let lowCutDb = 0;

        if (limiter) {
            mix ??= await readFloat(raw, samples);

            if (guard) {
                filterPass(mix, "highpass", RUMBLE_HZ);
                lowCutDb = guardLows(mix, LOW_GUARD_DB);
            }
        }

        for (let attempt = 0; attempt < attempts; attempt++) {
            const last = attempt === attempts - 1;
            let source = raw;
            // The loudness the file is brought to: the target, or less when the loss cap stopped the limiter.
            let goal = targetLufs;

            if (limiter && mix) {
                source = join(folder, "limited.wav");
                const reached = await limitToTarget({
                    mix,
                    file: source,
                    trim,
                    targetLufs,
                    ceilingDb: peakDb - margin,
                    clipDb: score.master?.clip ?? 3,
                    maxLossDb: guard ? MAX_LIMITER_LOSS_DB : Number.POSITIVE_INFINITY,
                });
                goal = Math.min(targetLufs, reached.lufs + 0.15);
                report = {
                    limiterLossDb: Number(reached.lossDb.toFixed(2)),
                    shortOfTargetDb: Number(Math.max(0, targetLufs - reached.lufs - 0.15).toFixed(2)),
                    lowCutDb: Number(lowCutDb.toFixed(2)),
                };
            }

            const measured = await analyze(source, trim);
            const gainDb = goal - measured.lufs - trimDb;
            const over = measured.truePeakDb + gainDb - peakDb;

            if (over > 0) {
                if (limiter && !last) {
                    margin += over + 0.3;
                    continue;
                }

                throw new Error(
                    `Score crest factor exceeds the peak cap at target LUFS by ${over.toFixed(1)} dB; reduce the loudest instrument, lower the loudness target, or set master.limiter in the score`
                );
            }

            try {
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
                            source,
                            "-af",
                            `${trim},volume=${gainDb.toFixed(6)}dB`,
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

                        const miss = result.lufs - goal;

                        if (miss > 0.35 || miss < -0.35 - trimDb || result.truePeakDb > peakDb + 0.1) {
                            throw new MasterMiss(
                                `Mastered output misses LUFS target or true-peak cap: ${result.lufs} LUFS for ${goal.toFixed(2)}, ${result.truePeakDb} dBTP for ${peakDb}`,
                                result.truePeakDb - peakDb
                            );
                        }
                    },
                });
                return;
            } catch (error) {
                if (!(error instanceof MasterMiss) || !limiter || last || error.peakOverDb <= 0) {
                    throw error;
                }

                // A lossy encoder lifts the peaks of limited audio, and a lower limiter ceiling only makes it lift
                // more. So the cap wins: the track ships that much quieter than the target.
                trimDb += error.peakOverDb + 0.1;
            }
        }
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
        master: report,
    };
}
