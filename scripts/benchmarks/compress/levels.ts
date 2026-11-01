#!/usr/bin/env bun
/**
 * Which zstd level each preset should use: every sample is compressed at every level with the repo's own seekable
 * writer (`compressFile`, the preset's frame size, line alignment and threads), then read back through the repo's
 * own readers, each step in a fresh process. The level is the only thing that changes between arms.
 *
 * Compress: CPU (the child's rusage, all threads), wall, peak RSS, output size; the output must decode to the
 * sample's sha256. Read, arms interleaved and rotated every run (plain, then each level):
 *   lines   readLinesSync over the whole file (jev sessions, daemon stats, ai-proxy calls --show)
 *   tail    readLastLines, 64 KiB ({{tail}}, poll-duty, the hub)
 *   rg      ripgrepFiles -c (tools genesis-tools logs day, daemon stats health)
 *   frames  readZstdFramesSync, every byte (restore: tools compress unpack, verify)
 * CPU is the child's rusage with its waited-for children (rg); `op` is the CPU of the read itself, without the
 * process start. Medians per arm; outputs must agree between arms.
 *
 * Samples: a folder of real data copied by hand (never the originals). The preset comes from the name:
 * `tree-*` tree, `binary-*` binary, `database-*` database, a folder (hang captures) text per file, anything else
 * text. Tree and binary run with long mode on and off.
 *
 * Usage:
 *   bun scripts/benchmarks/compress/levels.ts --samples <dir> --work <dir> [--levels 3,6,9,12,15,19,22]
 *     [--compress-runs 3] [--read-runs 7] [--only <sample,...>] [--out <file.json>]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { compressFile, digestZstdContent } from "@genesiscz/utils/compress/file";
import { type CompressPreset, PRESETS, type PresetName } from "@genesiscz/utils/compress/presets";
import { ripgrepFiles } from "@genesiscz/utils/compress/search";
import { isZstdPath, readZstdFramesSync } from "@genesiscz/utils/compress/zstd";
import { readLastLines, readLinesSync, readTextChunksSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { ripgrepBinary } from "@genesiscz/utils/ripgrep";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { median } from "../fs/shared";

type ReadMode = "lines" | "tail" | "rg" | "frames";
const RG_PATTERN = '"level":';
/** A sample is skipped when its outputs would leave less than this free. */
const MIN_FREE_BYTES = 256 * 1024 * 1024;

interface Setting {
    tag: string;
    level: number;
    long: boolean;
}

interface SampleSpec {
    name: string;
    path: string;
    preset: CompressPreset;
    /** A folder of small files, each compressed on its own (the hang captures). */
    perFile: boolean;
    modes: ReadMode[];
    bytes: number;
}

function flag(argv: string[], name: string): string | undefined {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
}

function filesOf(path: string): string[] {
    return statSync(path).isDirectory()
        ? readdirSync(path)
              .sort()
              .map((name) => join(path, name))
        : [path];
}

function presetFor(name: string): CompressPreset {
    if (name.startsWith("tree-")) {
        return PRESETS.tree;
    }

    if (name.startsWith("binary-")) {
        return PRESETS.binary;
    }

    if (name.startsWith("database-")) {
        return PRESETS.database;
    }

    return PRESETS.text;
}

function specs(dir: string, only: Set<string> | null): SampleSpec[] {
    return readdirSync(dir)
        .sort()
        .filter((name) => !only || only.has(name))
        .map((name) => {
            const path = join(dir, name);
            const perFile = statSync(path).isDirectory();
            const preset = presetFor(name);
            const binaryLike = preset.name !== "text";
            return {
                name,
                path,
                preset,
                perFile,
                modes: binaryLike ? ["frames"] : perFile ? ["lines"] : ["lines", "tail", "rg"],
                bytes: filesOf(path).reduce((sum, file) => sum + statSync(file).size, 0),
            };
        });
}

function settingsFor(spec: SampleSpec, levels: number[]): Setting[] {
    const longs = spec.preset.long ? [true, false] : [false];
    return levels.flatMap((level) => longs.map((long) => ({ tag: `L${level}${long ? "-long" : ""}`, level, long })));
}

function cpuMs(usage: NodeJS.ResourceUsage): number {
    return (usage.userCPUTime + usage.systemCPUTime) / 1000;
}

// ── children ────────────────────────────────────────────────────────────────────────────────────────────────

interface CompressJob {
    preset: PresetName;
    level: number;
    long: boolean;
    /** [source, target] per file. */
    pairs: Array<[string, string]>;
}

async function childCompress(args: string[]): Promise<unknown> {
    const job = SafeJSON.parse(args[0] ?? "", { strict: true }) as CompressJob;
    const preset = PRESETS[job.preset];
    const before = process.resourceUsage();
    const started = performance.now();
    let compressedBytes = 0;

    for (const [source, target] of job.pairs) {
        mkdirSync(dirname(target), { recursive: true });
        const result = await compressFile({
            source,
            target,
            level: job.level,
            long: job.long,
            frameBytes: preset.frameBytes,
            threads: preset.threads,
            lineAligned: preset.lineAligned,
        });
        compressedBytes += result.compressedBytes;
    }

    return {
        opCpuMs: cpuMs(process.resourceUsage()) - cpuMs(before),
        opWallMs: performance.now() - started,
        compressedBytes,
    };
}

async function childRead(args: string[]): Promise<unknown> {
    const [mode, ...files] = args as [ReadMode, ...string[]];
    const before = process.resourceUsage();
    const hash = createHash("sha256");

    for (const file of files) {
        if (mode === "lines") {
            let count = 0;
            let length = 0;

            for (const line of readLinesSync(file)) {
                count += 1;
                length += line.length;
            }

            hash.update(`${count}:${length};`);
        } else if (mode === "tail") {
            hash.update(readLastLines(file).lines.join("\n"));
        } else if (mode === "rg") {
            const run = await ripgrepFiles({
                rg: ripgrepBinary() ?? "rg",
                args: ["--no-config", "--no-filename", "-c", "-F", RG_PATTERN],
                files: [file],
            });
            hash.update(run.stdout.trim());
        } else {
            const frames = isZstdPath(file) ? readZstdFramesSync(file) : readTextChunksSync(file);

            for (const frame of frames) {
                hash.update(frame);
            }
        }
    }

    return { opCpuMs: cpuMs(process.resourceUsage()) - cpuMs(before), check: hash.digest("hex").slice(0, 12) };
}

// ── parent ──────────────────────────────────────────────────────────────────────────────────────────────────

interface Spawned<T> {
    result: T;
    cpuMs: number;
    wallMs: number;
    rssMb: number;
}

async function spawnChild<T>(argv: string[]): Promise<Spawned<T>> {
    const started = performance.now();
    const proc = Bun.spawn(["bun", import.meta.path, "--child", ...argv], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    const wallMs = performance.now() - started;

    if (code !== 0) {
        throw new Error(`child ${argv.slice(0, 3).join(" ")} exited ${code}: ${stderr.slice(0, 600)}`);
    }

    const usage = proc.resourceUsage()!;
    return {
        result: SafeJSON.parse(stdout, { strict: true }) as T,
        cpuMs: (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1000,
        wallMs,
        rssMb: usage.maxRSS / 1e6,
    };
}

async function loadAverage(): Promise<string> {
    const text = await new Response(Bun.spawn(["uptime"], { stdout: "pipe" }).stdout).text();
    return text.trim().split("averages:")[1]?.trim() ?? text.trim();
}

function sha256Files(files: string[]): string {
    const hash = createHash("sha256");

    for (const file of files) {
        hash.update(readFileSync(file));
    }

    return hash.digest("hex");
}

function zstSha256(files: string[]): string {
    const hash = createHash("sha256");

    for (const file of files) {
        for (const frame of readZstdFramesSync(file)) {
            hash.update(frame);
        }
    }

    return hash.digest("hex");
}

interface CompressRow {
    sample: string;
    preset: string;
    tag: string;
    level: number;
    long: boolean;
    inputMb: number;
    outputMb: number;
    ratio: number;
    savingPct: number;
    cpuMs: number;
    opCpuMs: number;
    cpuMbPerS: number;
    wallMs: number;
    rssMb: number;
    identical: boolean;
}

interface ReadRow {
    sample: string;
    mode: ReadMode;
    arm: string;
    cpuMs: number;
    opCpuMs: number;
    wallMs: number;
    rssMb: number;
    checksAgree: boolean;
}

/** Where an arm's output of a sample goes: one fixed name per arm for a file sample, so the next sample overwrites it. */
function outputsFor(spec: SampleSpec, workDir: string, tag: string): string[] {
    return spec.perFile
        ? filesOf(spec.path).map((file) => join(workDir, tag, spec.name, `${basename(file)}.zst`))
        : [join(workDir, tag, "sample.zst")];
}

function freeBytes(path: string): number {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
}

/** One sample end to end: every arm compressed `compressRuns` times, then read `readRuns` times, arms interleaved. */
async function benchSample({
    spec,
    levels,
    workDir,
    compressRuns,
    readRuns,
}: {
    spec: SampleSpec;
    levels: number[];
    workDir: string;
    compressRuns: number;
    readRuns: number;
}): Promise<{ compressRows: CompressRow[]; readRows: ReadRow[] }> {
    const settings = settingsFor(spec, levels);
    const compressSamples = new Map<string, Array<Spawned<{ opCpuMs: number; compressedBytes: number }>>>();

    for (let run = 0; run < compressRuns; run++) {
        for (const setting of settings) {
            const outputs = outputsFor(spec, workDir, setting.tag);
            const pairs = filesOf(spec.path).map((file, index) => [file, outputs[index]!]);
            const spawned = await spawnChild<{ opCpuMs: number; compressedBytes: number }>([
                "compress",
                SafeJSON.stringify({ preset: spec.preset.name, level: setting.level, long: setting.long, pairs }),
            ]);
            compressSamples.set(setting.tag, [...(compressSamples.get(setting.tag) ?? []), spawned]);
        }
    }

    const plainSha = sha256Files(filesOf(spec.path));
    const compressRows = settings.map((setting): CompressRow => {
        const runs = compressSamples.get(setting.tag) ?? [];
        const outputs = outputsFor(spec, workDir, setting.tag);
        const outputBytes = runs[0]?.result.compressedBytes ?? 0;
        const opCpuMs = median(runs.map((run) => run.result.opCpuMs));
        return {
            sample: spec.name,
            preset: spec.preset.name,
            tag: setting.tag,
            level: setting.level,
            long: setting.long,
            inputMb: spec.bytes / 1e6,
            outputMb: outputBytes / 1e6,
            ratio: spec.bytes / Math.max(outputBytes, 1),
            savingPct: (1 - outputBytes / spec.bytes) * 100,
            cpuMs: median(runs.map((run) => run.cpuMs)),
            opCpuMs,
            cpuMbPerS: spec.bytes / 1e6 / (opCpuMs / 1000),
            wallMs: median(runs.map((run) => run.wallMs)),
            rssMb: median(runs.map((run) => run.rssMb)),
            identical:
                zstSha256(outputs) === plainSha &&
                outputs.reduce((sum, file) => sum + digestZstdContent(file).bytes, 0) === spec.bytes,
        };
    });

    const readSamples = new Map<string, Array<Spawned<{ opCpuMs: number; check: string }>>>();
    const checks = new Map<ReadMode, Set<string>>();
    const arms = ["plain", ...settings.map((setting) => setting.tag)];

    for (let run = 0; run < readRuns; run++) {
        const rotated = [...arms.slice(run % arms.length), ...arms.slice(0, run % arms.length)];

        for (const mode of spec.modes) {
            for (const arm of rotated) {
                const files = arm === "plain" ? filesOf(spec.path) : outputsFor(spec, workDir, arm);
                const spawned = await spawnChild<{ opCpuMs: number; check: string }>(["read", mode, ...files]);
                const key = `${mode}|${arm}`;
                readSamples.set(key, [...(readSamples.get(key) ?? []), spawned]);
                checks.set(mode, (checks.get(mode) ?? new Set()).add(spawned.result.check));
            }
        }
    }

    const readRows = [...readSamples].map(([key, runs]): ReadRow => {
        const [mode, arm] = key.split("|") as [ReadMode, string];
        return {
            sample: spec.name,
            mode,
            arm,
            cpuMs: median(runs.map((run) => run.cpuMs)),
            opCpuMs: median(runs.map((run) => run.result.opCpuMs)),
            wallMs: median(runs.map((run) => run.wallMs)),
            rssMb: median(runs.map((run) => run.rssMb)),
            checksAgree: (checks.get(mode)?.size ?? 0) === 1,
        };
    });

    return { compressRows, readRows };
}

async function parent(argv: string[]): Promise<void> {
    const samplesDir = flag(argv, "--samples");
    const workDir = flag(argv, "--work");

    if (!samplesDir || !workDir) {
        throw new Error("usage: levels.ts --samples <dir> --work <dir> [--levels 3,6,…] [--out file.json]");
    }

    mkdirSync(workDir, { recursive: true });
    const levels = (flag(argv, "--levels") ?? "3,6,9,12,15,19,22").split(",").map(Number);
    const compressRuns = Number(flag(argv, "--compress-runs") ?? 3);
    const readRuns = Number(flag(argv, "--read-runs") ?? 7);
    const onlyFlag = flag(argv, "--only");
    const only = onlyFlag ? new Set(onlyFlag.split(",")) : null;
    const outFile = flag(argv, "--out");
    const samples = specs(samplesDir, only);
    const loadBefore = await loadAverage();
    const compressRows: CompressRow[] = [];
    const readRows: ReadRow[] = [];
    const loads: string[] = [];
    out.log.info(`Bun ${Bun.version}, load ${loadBefore}, ${samples.length} samples, levels ${levels.join(",")}`);

    for (const spec of samples) {
        // Every arm's output exists at once while the arms are read (each at most half the input for every sample
        // here); never fill the disk for a benchmark.
        const need = (spec.bytes * settingsFor(spec, levels).length) / 2 + MIN_FREE_BYTES;

        if (freeBytes(workDir) < need) {
            out.log.warn(`skipped ${spec.name}: needs ${(need / 1e6).toFixed(0)} MB free`);
            continue;
        }

        const rows = await benchSample({ spec, levels, workDir, compressRuns, readRuns });
        compressRows.push(...rows.compressRows);
        readRows.push(...rows.readRows);
        loads.push(`${spec.name}: ${await loadAverage()}`);
        out.log.step(`${spec.name} done (load ${loads.at(-1)})`);

        if (outFile) {
            writeFileSync(
                outFile,
                SafeJSON.stringify({ bun: Bun.version, loadBefore, loads, compressRows, readRows }, null, 2)
            );
        }
    }

    const loadAfter = await loadAverage();
    printTables({ compressRows, readRows, samples, loadBefore, loadAfter });

    if (outFile) {
        out.log.info(`results: ${outFile}`);
    }

    const broken =
        compressRows.filter((row) => !row.identical).length + readRows.filter((row) => !row.checksAgree).length;

    if (broken > 0) {
        out.log.error(`${broken} rows did not round-trip or disagreed between arms`);
        process.exitCode = 1;
    }
}

function printTables({
    compressRows,
    readRows,
    samples,
    loadBefore,
    loadAfter,
}: {
    compressRows: CompressRow[];
    readRows: ReadRow[];
    samples: SampleSpec[];
    loadBefore: string;
    loadAfter: string;
}): void {
    renderCliHeader("Compress per level", `load ${loadBefore} → ${loadAfter}`);
    const compressTable = createBoxTable([
        "SAMPLE",
        "ARM",
        "MB IN",
        "RATIO",
        "SAVING",
        "CPU ms",
        "MB/s CPU",
        "RSS MB",
        "OK",
    ]);

    for (const row of compressRows) {
        compressTable.push([
            row.sample,
            row.tag,
            row.inputMb.toFixed(1),
            `x${row.ratio.toFixed(1)}`,
            `${row.savingPct.toFixed(2)}%`,
            row.opCpuMs.toFixed(0),
            row.cpuMbPerS.toFixed(1),
            row.rssMb.toFixed(0),
            row.identical ? "same" : "DIFFERS",
        ]);
    }

    out.println(compressTable.toString());
    renderCliHeader(
        "Read per level",
        "median CPU ms of the process (op = the read alone); Δ against plain and level 3"
    );
    const readTable = createBoxTable([
        "SAMPLE",
        "MODE",
        "ARM",
        "CPU ms",
        "op ms",
        "Δ plain",
        "Δ L3 op",
        "RSS MB",
        "CHECK",
    ]);

    for (const spec of samples) {
        for (const mode of spec.modes) {
            const rows = readRows.filter((row) => row.sample === spec.name && row.mode === mode);
            const plain = rows.find((row) => row.arm === "plain");
            const level3 = rows.find((row) => row.arm === "L3" || row.arm === "L3-long");

            for (const row of rows.sort((a, b) => armOrder(a.arm) - armOrder(b.arm))) {
                const delta = (base: number | undefined, value: number) =>
                    base ? `${value >= base ? "+" : ""}${((value / base - 1) * 100).toFixed(0)}%` : "";
                readTable.push([
                    spec.name,
                    mode,
                    row.arm,
                    row.cpuMs.toFixed(0),
                    row.opCpuMs.toFixed(0),
                    delta(plain?.cpuMs, row.cpuMs),
                    delta(level3?.opCpuMs, row.opCpuMs),
                    row.rssMb.toFixed(0),
                    row.checksAgree ? "same" : "DIFFERS",
                ]);
            }
        }
    }

    out.println(readTable.toString());
}

function armOrder(arm: string): number {
    if (arm === "plain") {
        return -1;
    }

    const level = Number(/^L(\d+)/.exec(arm)?.[1] ?? 0);
    return level * 2 + (arm.endsWith("-long") ? 0 : 1);
}

if (process.argv[2] === "--child") {
    const [, kind, ...rest] = process.argv.slice(2);
    const result = kind === "compress" ? await childCompress(rest) : await childRead(rest);
    process.stdout.write(SafeJSON.stringify(result));
} else {
    await parent(process.argv.slice(2));
}
