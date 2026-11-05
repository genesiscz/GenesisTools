#!/usr/bin/env bun
/**
 * The meeting recorder's OCR path, measured as the recorder calls it: `recognizeText(jpg, { languages })` from
 * `@genesiscz/utils/macos/ocr`, once per kept frame, one frame at a time (`src/meetings/lib/recorder.ts`, `keepFrames`).
 *
 * What it measures, per run (the recorded value is the per-metric median over runs):
 *   - wall ms and CPU ms per warm call. CPU is the darwinkit child's `cputime` (it runs Vision; `ps` resolves 10 ms) plus
 *     this process's own CPU for the call, plus the `sips` dimension probe `recognizeText` starts for every accurate call.
 *   - one cold start against a warm call: the shared darwinkit helper is closed, the first frame is read (this starts the
 *     helper), then the same frame is read again.
 *   - the text change between consecutive sampled frames of one display (the share of lines that changed).
 *   - from the real `ocr.jsonl` of the meeting (every frame, no OCR run): per display, the share of consecutive frames
 *     whose line sets are identical, differ in 1 to 2 lines, or differ only in clock-like lines.
 *
 * Input: up to 40 frames, every 13th file of the meeting's `frames/` folder, copied (the source is only read) into the
 * scratch folder. Defaults to the 2026-11-04 meeting. The baseline is `scripts/benchmarks/baselines/meetings-ocr.json`.
 *
 * Usage:
 *   bun scripts/benchmarks/meetings-ocr/bench.ts [--runs 3] [--meeting <folder>] [--scratch <dir>] [--baseline] [--compare] [--json]
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type BaselineMetrics, withSpawnCounter } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { closeDarwinKit } from "@genesiscz/utils/macos/darwinkit";
import { recognizeText } from "@genesiscz/utils/macos/ocr";
import { captureSync, listPsTable, parseCpuTime } from "@genesiscz/utils/process/ps";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { finishBench, median, parseBenchArgs, summarize } from "../fs/shared";

const BASELINE_NAME = "meetings-ocr";
const EVERY_NTH = 13;
const MAX_FRAMES = 40;
const DEFAULT_MEETING = genesisToolsDir("meetings", "2026-11-04_16-32-meeting");
const DEFAULT_SCRATCH = join(tmpdir(), "meetings-ocr-bench", "frames");
/** The recorder's default OCR languages (`languageSettings(meetingsConfigSchema.parse({})).ocr`), fixed here so the numbers do not move with a config change. */
const LANGUAGES = ["en-US"];
/** A line that only shows a time: a menu bar clock, a call timer, a "16:31" next to a chat row. */
const CLOCK_LINE = /\b\d{1,2}[:.]\d{2}(?::\d{2})?\b/;
const CLOCK_LINE_MAX_CHARS = 30;

interface OcrRecord {
    file: string;
    displayId: number;
    text: string;
}

interface FrameRef {
    path: string;
    displayId: number;
    name: string;
}

function flagValue(flag: string): string | undefined {
    const at = process.argv.indexOf(flag);

    return at > 0 ? process.argv[at + 1] : undefined;
}

function displayOf(name: string): number {
    const match = /-d(\d+)\.jpg$/.exec(name);

    if (!match) {
        throw new Error(`Frame name without a display suffix: ${name}`);
    }

    return Number(match[1]);
}

/** Every `EVERY_NTH`th frame of the meeting (sorted by name, which is time then display), copied into `scratch`. */
function prepareFrames(meeting: string, scratch: string): FrameRef[] {
    const source = join(meeting, "frames");
    const names = readdirSync(source)
        .filter((name) => name.endsWith(".jpg"))
        .sort();
    mkdirSync(scratch, { recursive: true });
    const picked = names.filter((_, index) => index % EVERY_NTH === 0).slice(0, MAX_FRAMES);

    return picked.map((name) => {
        const path = join(scratch, name);

        copyFileSync(join(source, name), path);

        return { path, displayId: displayOf(name), name };
    });
}

function linesOf(text: string): string[] {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

interface LineDiff {
    added: string[];
    removed: string[];
    /** The larger of the two sides: a clock that ticks is one added and one removed line, so it counts as 1. */
    changed: number;
    /** Share of the later frame's distinct lines that the earlier frame did not have. */
    changedShare: number;
    clockOnly: boolean;
}

function isClockLine(line: string): boolean {
    return line.length <= CLOCK_LINE_MAX_CHARS && CLOCK_LINE.test(line);
}

function diffLines(before: string, after: string): LineDiff {
    const a = new Set(linesOf(before));
    const b = new Set(linesOf(after));
    const added = [...b].filter((line) => !a.has(line));
    const removed = [...a].filter((line) => !b.has(line));
    const changed = Math.max(added.length, removed.length);

    return {
        added,
        removed,
        changed,
        changedShare: b.size === 0 ? 0 : added.length / b.size,
        clockOnly: changed > 0 && [...added, ...removed].every(isClockLine),
    };
}

function readOcrJsonl(meeting: string): OcrRecord[] {
    const text = readFileSync(join(meeting, "ocr.jsonl"), "utf-8");

    return text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
            const row = SafeJSON.parse(line, { strict: true }) as OcrRecord;

            return { file: row.file, displayId: row.displayId, text: row.text };
        });
}

/** Per display, the share of consecutive frames by how many lines differ, over the real `ocr.jsonl`. */
function jsonlMetrics(records: OcrRecord[]): { metrics: BaselineMetrics; detail: Record<string, unknown> } {
    const byDisplay = new Map<number, OcrRecord[]>();

    for (const record of records) {
        const list = byDisplay.get(record.displayId) ?? [];
        list.push(record);
        byDisplay.set(record.displayId, list);
    }

    const metrics: BaselineMetrics = {};
    const detail: Record<string, unknown> = {};
    const total = { pairs: 0, identical: 0, tiny: 0, clockOnly: 0 };

    for (const [displayId, list] of [...byDisplay.entries()].sort((x, y) => x[0] - y[0])) {
        let pairs = 0;
        let identical = 0;
        let tiny = 0;
        let clockOnly = 0;
        const changedShares: number[] = [];

        for (let index = 1; index < list.length; index++) {
            const diff = diffLines((list[index - 1] as OcrRecord).text, (list[index] as OcrRecord).text);
            pairs += 1;
            changedShares.push(diff.changedShare);

            if (diff.changed === 0) {
                identical += 1;
            } else if (diff.changed <= 2) {
                tiny += 1;
            }

            if (diff.clockOnly) {
                clockOnly += 1;
            }
        }

        const pct = (count: number) => (pairs === 0 ? 0 : Math.round((count / pairs) * 1000) / 10);
        metrics[`jsonlFramesD${displayId}`] = list.length;
        metrics[`jsonlIdenticalPctD${displayId}`] = pct(identical);
        metrics[`jsonlTinyDiffPctD${displayId}`] = pct(tiny);
        metrics[`jsonlClockOnlyPctD${displayId}`] = pct(clockOnly);
        metrics[`jsonlMedianChangedLinesPctD${displayId}`] =
            Math.round(median(changedShares.length ? changedShares : [0]) * 1000) / 10;
        total.pairs += pairs;
        total.identical += identical;
        total.tiny += tiny;
        total.clockOnly += clockOnly;
        detail[`d${displayId}`] = { frames: list.length, pairs, identical, tinyDiff1to2: tiny, clockOnly };
    }

    const allPct = (count: number) => (total.pairs === 0 ? 0 : Math.round((count / total.pairs) * 1000) / 10);
    metrics.jsonlFrames = records.length;
    metrics.jsonlIdenticalPctAll = allPct(total.identical);
    metrics.jsonlTinyDiffPctAll = allPct(total.tiny);
    metrics.jsonlSkippablePctAll = allPct(total.identical + total.tiny);
    metrics.jsonlClockOnlyPctAll = allPct(total.clockOnly);
    detail.all = total;

    return { metrics, detail };
}

/** The darwinkit helper this process started: the child of this process whose command names darwinkit. */
async function darwinkitChildPid(): Promise<number | null> {
    const rows = await listPsTable();
    const child = rows.find((row) => row.ppid === process.pid && /darwinkit/i.test(row.command));

    return child?.pid ?? null;
}

function cpuMsOf(pid: number | null): number {
    if (pid === null) {
        return 0;
    }

    const result = captureSync("ps", ["-p", String(pid), "-o", "cputime="]);

    return parseCpuTime(result.stdout) ?? 0;
}

function processCpuMs(): number {
    const usage = process.cpuUsage();

    return (usage.user + usage.system) / 1000;
}

interface CallSample {
    wallMs: number;
    helperCpuMs: number;
    ownCpuMs: number;
    spawns: number;
    lines: number;
    chars: number;
    text: string;
}

async function callOnce(frame: FrameRef, helperPid: number | null): Promise<CallSample> {
    const helperBefore = cpuMsOf(helperPid);
    const ownBefore = processCpuMs();
    const started = performance.now();
    const counted = await withSpawnCounter(() => recognizeText(frame.path, { languages: LANGUAGES }));
    const wallMs = performance.now() - started;
    const ownCpuMs = processCpuMs() - ownBefore;
    const helperCpuMs = cpuMsOf(helperPid) - helperBefore;

    return {
        wallMs,
        helperCpuMs,
        ownCpuMs,
        spawns: counted.count,
        lines: linesOf(counted.result.text).length,
        chars: counted.result.text.length,
        text: counted.result.text,
    };
}

/** The CPU of the `sips -g` dimension probe `recognizeText` starts before every accurate call (the child's own rusage). */
async function sipsProbeCpuMs(frame: FrameRef): Promise<number> {
    const proc = Bun.spawn(["sips", "-g", "pixelWidth", "-g", "pixelHeight", frame.path], {
        stdout: "pipe",
        stderr: "pipe",
    });
    await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const usage = proc.resourceUsage();

    return usage ? (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1000 : 0;
}

interface RunResult {
    metrics: BaselineMetrics;
    detail: Record<string, unknown>;
}

async function runOnce(frames: FrameRef[]): Promise<RunResult> {
    closeDarwinKit();
    const first = frames[0] as FrameRef;
    const cold = await callOnce(first, null);
    const helperPid = await darwinkitChildPid();
    const coldHelperCpuMs = cpuMsOf(helperPid);
    const warmSame = await callOnce(first, helperPid);
    const samples: Array<{ frame: FrameRef; sample: CallSample }> = [];

    for (const frame of frames) {
        samples.push({ frame, sample: await callOnce(frame, helperPid) });
    }

    const sipsCpu: number[] = [];

    for (const frame of frames.slice(0, 10)) {
        sipsCpu.push(await sipsProbeCpuMs(frame));
    }

    const lastByDisplay = new Map<number, string>();
    const changedShares: number[] = [];
    let emptyFrames = 0;

    for (const { frame, sample } of samples) {
        const previous = lastByDisplay.get(frame.displayId);

        if (previous !== undefined) {
            changedShares.push(diffLines(previous, sample.text).changedShare);
        }

        lastByDisplay.set(frame.displayId, sample.text);

        if (sample.chars === 0) {
            emptyFrames += 1;
        }
    }

    const wall = summarize(samples.map((one) => one.sample.wallMs));
    const helperCpu = summarize(samples.map((one) => one.sample.helperCpuMs));
    const ownCpu = summarize(samples.map((one) => one.sample.ownCpuMs));
    const perDisplayWall: Record<string, number> = {};

    for (const displayId of new Set(frames.map((frame) => frame.displayId))) {
        perDisplayWall[`d${displayId}`] = Math.round(
            median(samples.filter((one) => one.frame.displayId === displayId).map((one) => one.sample.wallMs))
        );
    }

    const metrics: BaselineMetrics = {
        frames: frames.length,
        coldCallWallMs: Math.round(cold.wallMs),
        warmSameFrameWallMs: Math.round(warmSame.wallMs),
        coldStartExtraWallMs: Math.round(cold.wallMs - warmSame.wallMs),
        coldHelperCpuMs: coldHelperCpuMs,
        warmSameFrameHelperCpuMs: warmSame.helperCpuMs,
        coldStartExtraHelperCpuMs: Math.max(0, coldHelperCpuMs - warmSame.helperCpuMs),
        warmWallMsMedian: Math.round(wall.median),
        warmWallMsMax: Math.round(wall.max),
        warmHelperCpuMsMedian: helperCpu.median,
        warmOwnCpuMsMedian: Math.round(ownCpu.median * 10) / 10,
        sipsProbeCpuMsMedian: Math.round(median(sipsCpu) * 10) / 10,
        spawnsPerCall: median(samples.map((one) => one.sample.spawns)),
        emptyFrames,
        linesPerFrameMedian: median(samples.map((one) => one.sample.lines)),
        sampledChangedLinesPct: Math.round(median(changedShares.length ? changedShares : [0]) * 1000) / 10,
        sampledChangedLinesPctMean:
            Math.round(
                (changedShares.reduce((sum, value) => sum + value, 0) / Math.max(1, changedShares.length)) * 1000
            ) / 10,
    };

    return {
        metrics,
        detail: {
            helperPid,
            wallMs: wall,
            helperCpuMs: helperCpu,
            ownCpuMs: ownCpu,
            perDisplayWallMedianMs: perDisplayWall,
            changedSharePairs: changedShares.length,
        },
    };
}

async function main(): Promise<void> {
    const args = parseBenchArgs(process.argv.slice(2));
    const meeting = flagValue("--meeting") ?? DEFAULT_MEETING;
    const scratch = flagValue("--scratch") ?? DEFAULT_SCRATCH;
    const warmup = process.argv.includes("--warmup") ? args.warmup : 0;
    const frames = prepareFrames(meeting, scratch);
    const perDisplay = new Map<number, number>();

    for (const frame of frames) {
        perDisplay.set(frame.displayId, (perDisplay.get(frame.displayId) ?? 0) + 1);
    }

    out.println(`${frames.length} frames from ${basename(meeting)} (every ${EVERY_NTH}th), copied to ${scratch}`);
    out.println(`frames per display: ${[...perDisplay.entries()].map(([id, count]) => `d${id}=${count}`).join(" ")}`);

    for (let index = 0; index < warmup; index++) {
        await runOnce(frames);
    }

    const jsonl = jsonlMetrics(readOcrJsonl(meeting));
    const runs: BaselineMetrics[] = [];
    const details: Array<Record<string, unknown>> = [];

    for (let index = 0; index < args.runs; index++) {
        const result = await runOnce(frames);
        runs.push({ ...result.metrics, ...jsonl.metrics });
        details.push(result.detail);
    }

    closeDarwinKit();

    const lowerIsBetter = [
        "coldCallWallMs",
        "warmSameFrameWallMs",
        "coldStartExtraWallMs",
        "coldHelperCpuMs",
        "warmSameFrameHelperCpuMs",
        "coldStartExtraHelperCpuMs",
        "warmWallMsMedian",
        "warmWallMsMax",
        "warmHelperCpuMsMedian",
        "warmOwnCpuMsMedian",
        "sipsProbeCpuMsMedian",
        "spawnsPerCall",
        "emptyFrames",
    ];

    await finishBench({
        name: BASELINE_NAME,
        title: "meetings-ocr: recognizeText as the recorder calls it",
        args,
        runs,
        lowerIsBetter,
        floor: {
            coldCallWallMs: 150,
            warmSameFrameWallMs: 60,
            coldStartExtraWallMs: 150,
            coldHelperCpuMs: 150,
            warmSameFrameHelperCpuMs: 50,
            coldStartExtraHelperCpuMs: 150,
            warmWallMsMedian: 60,
            warmWallMsMax: 200,
            warmHelperCpuMsMedian: 50,
            warmOwnCpuMsMedian: 10,
            sipsProbeCpuMsMedian: 5,
        },
        notes: `${frames.length} frames (every ${EVERY_NTH}th of ${basename(meeting)}), languages ${LANGUAGES.join(",")}, accurate level, one frame at a time; helper CPU from ps cputime (10 ms resolution); the jsonl* metrics read the meeting's ocr.jsonl and do not move with code`,
        context: {
            meeting,
            scratch,
            perDisplayFrames: Object.fromEntries(perDisplay),
            jsonl: jsonl.detail,
            runDetails: details,
        },
    });
}

await main();
