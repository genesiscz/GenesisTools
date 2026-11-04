#!/usr/bin/env bun
/**
 * The export's noise reduction (`@genesiscz/utils/recording-editor/denoise`) on one movie: the CPU of making the
 * cleaned copy, and what it does to the sound.
 *
 * Per strength (`--db 8,12,20`): the ffmpeg command the export runs (denoisedSourceArgv), its CPU (the child's own
 * rusage) and wall time, then the sound before and after: the RMS level of the whole track, of its quietest 10% of
 * 100 ms windows (the room between words: the noise), and of its loudest 10% (the words), in dBFS. A good setting
 * drops the quiet windows a lot and the loud ones little.
 *
 * Usage: bun scripts/benchmarks/recorder-denoise/bench.ts <movie> [--db 8,12,20] [--scratch <dir>] [--json]
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { denoisedSourceArgv, denoiseSchema } from "@genesiscz/utils/recording-editor/denoise";

function flagValue(flag: string): string | undefined {
    const at = process.argv.indexOf(flag);
    return at > 0 ? process.argv[at + 1] : undefined;
}

async function run(argv: string[]): Promise<{ stdout: string; stderr: string; cpuMs: number; wallMs: number }> {
    const started = performance.now();
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        throw new Error(`${argv[0]} exited ${exitCode}: ${stderr.slice(-400)}`);
    }

    const usage = proc.resourceUsage();
    const cpuMs = usage ? (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1000 : 0;
    return { stdout, stderr, cpuMs, wallMs: performance.now() - started };
}

/** RMS per 100 ms window of the first audio track, in dBFS, from ffmpeg's astats per-frame metadata. */
async function windowLevels(movie: string): Promise<number[]> {
    const { stdout } = await run([
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-i",
        movie,
        "-map",
        "0:a:0",
        "-af",
        "asetnsamples=n=4800,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
        "-f",
        "null",
        "-",
    ]);
    return stdout
        .split("\n")
        .filter((line) => line.startsWith("lavfi.astats.Overall.RMS_level="))
        .map((line) => Number(line.split("=")[1]))
        .filter((value) => Number.isFinite(value));
}

function summary(levels: number[]): { all: number; quiet10: number; loud10: number; windows: number } {
    const sorted = [...levels].sort((a, b) => a - b);
    const share = Math.max(1, Math.floor(sorted.length / 10));
    const power = (values: number[]) =>
        10 * Math.log10(values.reduce((sum, db) => sum + 10 ** (db / 10), 0) / Math.max(1, values.length));
    const round = (value: number) => Math.round(value * 10) / 10;
    return {
        all: round(power(sorted)),
        quiet10: round(power(sorted.slice(0, share))),
        loud10: round(power(sorted.slice(-share))),
        windows: sorted.length,
    };
}

async function main(): Promise<void> {
    const movie = process.argv[2];

    if (!movie || movie.startsWith("--")) {
        throw new Error("give the movie: bun scripts/benchmarks/recorder-denoise/bench.ts <movie>");
    }

    const scratch = flagValue("--scratch") ?? join(tmpdir(), "recorder-denoise-bench");
    mkdirSync(scratch, { recursive: true });
    const strengths = (flagValue("--db") ?? "8,12,20").split(",").map(Number);
    const before = summary(await windowLevels(movie));
    const arms: Record<string, unknown> = {};

    for (const reductionDb of strengths) {
        const output = join(scratch, `denoised-${reductionDb}.mp4`);
        const settings = denoiseSchema.parse({ reductionDb });
        const made = await run(denoisedSourceArgv({ source: movie, output, audioTracks: 1, settings }));
        const after = summary(await windowLevels(output));
        arms[`${reductionDb}dB`] = {
            cpuMs: Math.round(made.cpuMs),
            wallMs: Math.round(made.wallMs),
            after,
            quietDropDb: Math.round((before.quiet10 - after.quiet10) * 10) / 10,
            loudDropDb: Math.round((before.loud10 - after.loud10) * 10) / 10,
        };
    }

    const result = { movie, before, arms };

    if (process.argv.includes("--json")) {
        out.result(result);
        return;
    }

    out.println(SafeJSON.stringify(result, null, 2));
}

await main();
