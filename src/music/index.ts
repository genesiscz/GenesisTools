#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { runTool } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import {
    auditionMusic,
    builtinScore,
    CHOSEN_TAP,
    installSoundfont,
    measureAudio,
    mixMusic,
    PINNED_SOUNDFONT,
    renderScore,
    scoreSchema,
    soundfontPaths,
    TAPS,
    TRACK_KEYS,
    tapAudio,
    tapAudition,
    verifySoundfont,
    withMusicSignal,
} from "@genesiscz/utils/music";
import { publishAudio } from "@genesiscz/utils/music/process";
import { Command, InvalidArgumentError } from "commander";

const program = new Command("music").description("Reproducible offline music and effects, mastered by loudness");

function number(value: string): number {
    const result = Number(value);

    if (!Number.isFinite(result)) {
        throw new InvalidArgumentError("Expected a finite number");
    }

    return result;
}

program
    .command("list")
    .description("List built-in scores and preserved tap variants")
    .action(() => {
        out.result({
            tracks: TRACK_KEYS.map((key) => {
                const score = builtinScore(key);
                return { key, title: score.title, bpm: score.bpm, seconds: score.seconds, end: score.end };
            }),
            taps: TAPS.map(([key, description]) => ({ key, description })),
        });
    });

program
    .command("score")
    .argument("<track>")
    .description("Print a built-in score as editable JSON")
    .action((track: string) => {
        out.result(builtinScore(track));
    });

const soundfont = program.command("soundfont").description("Manage the explicitly pinned sample asset");
soundfont
    .command("install")
    .description("Download and verify GeneralUser GS 2.0.3 and its full license")
    .action(async () => {
        out.result({ ...(await installSoundfont()), provenance: PINNED_SOUNDFONT });
    });
soundfont
    .command("show")
    .description("Read and verify the installed asset without downloading")
    .action(async () => {
        const paths = soundfontPaths();
        out.result({ ...paths, sha256: await verifySoundfont(paths.file), provenance: PINNED_SOUNDFONT });
    });

interface RenderOptions {
    out: string;
    score?: string;
    soundfont?: string;
    lufs: number;
    peak: number;
    overwrite?: boolean;
}

program
    .command("render")
    .argument("[track]", "Built-in key", "PulseLight")
    .requiredOption("--out <file>", "New .wav or .m4a output")
    .option("--score <json>", "Custom score document, instead of a built-in")
    .option("--soundfont <file>", "Explicit alternate SoundFont, whose hash is recorded")
    .option("--lufs <number>", "Integrated loudness target", number, -20)
    .option("--peak <db>", "True-peak ceiling", number, -3)
    .option("--overwrite", "Replace the output only after successful mastering")
    .description("Render MIDI through FluidSynth; no movie fades are baked into the track")
    .action(async (track: string, options: RenderOptions) => {
        const score = options.score
            ? scoreSchema.parse(SafeJSON.parse(await readFile(options.score, "utf8"), { strict: true }))
            : builtinScore(track);
        out.result(
            await renderScore({
                score,
                output: options.out,
                soundfont: options.soundfont,
                targetLufs: options.lufs,
                peakDb: options.peak,
                overwrite: options.overwrite,
            })
        );
    });

program
    .command("measure")
    .argument("<file>")
    .description("Read integrated LUFS, true peak, band RMS and SHA-256")
    .action(async (file: string) => out.result(await measureAudio(file)));

interface MixCliOptions {
    music: string;
    end: number;
    out: string;
    volume: number;
    fadeIn: number;
    fadeOut: number;
    duck: boolean;
    threshold: number;
    ratio: number;
    attackMs: number;
    releaseMs: number;
    overwrite?: boolean;
}

program
    .command("mix")
    .argument("<video>")
    .requiredOption("--music <file>", "Rendered music")
    .requiredOption("--end <seconds>", "Written ending from the score, not the file duration", number)
    .requiredOption("--out <mp4>", "New movie")
    .option("--volume <gain>", "Music gain, 0.6 puts a -20 LUFS track near -24.4 LUFS", number, 0.6)
    .option("--fade-in <seconds>", "Mix-time music fade-in", number, 1.5)
    .option("--fade-out <seconds>", "Mix-time music fade-out", number, 3)
    .option("--no-duck", "Disable effects-driven ducking")
    .option("--threshold <level>", "Sidechain threshold", number, 0.03)
    .option("--ratio <number>", "Sidechain ratio", number, 4)
    .option("--attack-ms <ms>", "Ducking attack", number, 8)
    .option("--release-ms <ms>", "Ducking release", number, 350)
    .option("--overwrite", "Replace output only after a successful mix")
    .description("Align the written end to the movie end, fade and duck under its effects; copy picture")
    .action(async (video: string, options: MixCliOptions) => {
        out.result(await mixMusic({ video, ...options, output: options.out }));
    });

interface AuditionOptions {
    out: string;
    seconds: number;
    start: number;
    overwrite?: boolean;
}
program
    .command("audition")
    .argument("<files...>", "Tracks, in playback order")
    .requiredOption("--out <file>", "New .wav or .m4a reel")
    .option("--seconds <n>", "Seconds per variant", number, 24)
    .option("--start <n>", "Start inside each variant", number, 12)
    .option("--overwrite", "Replace output after success")
    .description("Put equally long excerpts in one listening reel")
    .action(async (files: string[], options: AuditionOptions) => {
        out.result(await auditionMusic({ ...options, files, output: options.out }));
    });

interface TapOptions {
    out: string;
    all?: boolean;
    overwrite?: boolean;
}
program
    .command("tap")
    .argument("[key]", "Tap key", CHOSEN_TAP)
    .requiredOption("--out <wav>", "New WAV output")
    .option("--all", "Audition all ten, repeated three times")
    .option("--overwrite", "Replace output after synthesis")
    .description("Generate a seeded UI tap, or the original ten-variant audition reel")
    .action(async (key: string, options: TapOptions) => {
        const audio = options.all ? tapAudition() : tapAudio(key);
        await publishAudio({
            output: options.out,
            overwrite: options.overwrite,
            prepare: async (temporary) => {
                await writeFile(temporary, audio);
            },
        });
        out.result({ output: options.out, key: options.all ? "all-ten" : key });
    });

await withInterrupt(
    async (signal) => {
        try {
            await withMusicSignal({ signal, run: () => runTool(program, { tool: "music" }) });
        } finally {
            if (signal.aborted) {
                process.exitCode = 130;
            }
        }
    },
    { handleTermination: true }
);
