#!/usr/bin/env bun
/**
 * The OCR read savings of the shared frame output (`FrameOutput` with `ocr.threshold` and `ocr.skipTextless`),
 * measured on consecutive real frames of a meeting, against reading every kept frame whole.
 *
 * Input: two runs of consecutive frames (the two displays with the most rows in `ocr.jsonl`, `--frames` each, from
 * the middle of the meeting), copied into the scratch folder; the meeting is only read. Each frame's `changePercent`
 * and `reason` come from its `ocr.jsonl` row; its motion boxes are computed against the frame before it with the
 * recorder's own algorithm (`motion.ts`, a port of FrameSampler.swift).
 *
 * Arms (one `FrameOutput` each, interleaved per frame, the order turned each run): `full` (the defaults), and one arm
 * per saving in `ARMS`. Per arm: the darwinkit helper's CPU over the whole sequence (`ps cputime`, 10 ms resolution),
 * this process's CPU, spawned children, skipped frames, and how much of the `full` arm's text each frame keeps
 * (folded line sets: the share of the full read's lines found in the arm's row).
 *
 * Usage: bun scripts/benchmarks/meetings-ocr/region.ts [--runs 3] [--frames 16] [--meeting <folder>] [--scratch <dir>] [--json]
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { withSpawnCounter } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { closeDarwinKit } from "@genesiscz/utils/macos/darwinkit";
import { recognizeText } from "@genesiscz/utils/macos/ocr";
import { foldText } from "@genesiscz/utils/macos/ocr-boxes";
import { captureSync, listPsTable, parseCpuTime } from "@genesiscz/utils/process/ps";
import { OCR_READ_DEFAULTS, type RecorderSettings } from "@genesiscz/utils/screen-recorder/control";
import { FrameOutput, type OcrRow } from "@genesiscz/utils/screen-recorder/frame-output";
import type { CapturedFrame } from "@genesiscz/utils/screen-recorder/types";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { median } from "../fs/shared";
import { changePercent, motionBoxes, signatureOf } from "./motion";

const DEFAULT_MEETING = genesisToolsDir("meetings", "2026-11-04_16-32-meeting");
const DEFAULT_SCRATCH = join(tmpdir(), "meetings-ocr-bench", "region");
const LANGUAGES = ["en-US"];

type ReadSettings = Pick<RecorderSettings["ocr"], "threshold" | "skipTextless">;

/** The arms beside `full`. A threshold above `capture.threshold` (2%) is needed to skip anything a capture kept. */
const ARMS: Record<string, ReadSettings> = {
    full: OCR_READ_DEFAULTS,
    "threshold-5": { ...OCR_READ_DEFAULTS, threshold: 5 },
    textless: { ...OCR_READ_DEFAULTS, skipTextless: true },
    "threshold-5+textless": { ...OCR_READ_DEFAULTS, threshold: 5, skipTextless: true },
};

interface Row {
    file: string;
    displayId: number;
    changePercent?: number;
    reason?: string;
}

interface BenchFrame {
    path: string;
    displayId: number;
    frame: Omit<CapturedFrame, "path" | "atMs">;
}

function flagValue(flag: string): string | undefined {
    const at = process.argv.indexOf(flag);
    return at > 0 ? process.argv[at + 1] : undefined;
}

function readRows(meeting: string): Row[] {
    return readFileSync(join(meeting, "ocr.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
            const row = SafeJSON.parse(line, { strict: true }) as Row;
            return { file: row.file, displayId: row.displayId, changePercent: row.changePercent, reason: row.reason };
        });
}

/** `count` consecutive rows of each of the two busiest displays, from the middle, as frames with motion facts. */
async function prepare(meeting: string, scratch: string, count: number): Promise<BenchFrame[][]> {
    const byDisplay = new Map<number, Row[]>();

    for (const row of readRows(meeting)) {
        byDisplay.set(row.displayId, [...(byDisplay.get(row.displayId) ?? []), row]);
    }

    const busiest = [...byDisplay.values()].sort((a, b) => b.length - a.length).slice(0, 2);
    mkdirSync(scratch, { recursive: true });
    const sequences: BenchFrame[][] = [];

    for (const rows of busiest) {
        const ordered = [...rows].sort((a, b) => a.file.localeCompare(b.file));
        const start = Math.max(0, Math.floor(ordered.length / 2) - Math.floor(count / 2));
        const picked = ordered.slice(start, start + count);
        const frames: BenchFrame[] = [];
        let previous: Awaited<ReturnType<typeof signatureOf>> | undefined;

        for (const [index, row] of picked.entries()) {
            const path = join(scratch, row.file.replace(/^frames\//, ""));

            if (!existsSync(path)) {
                copyFileSync(join(meeting, row.file), path);
            }

            const signature = await signatureOf(path);
            const reason = index === 0 ? "first" : (row.reason ?? "change");
            const comparable = previous && (reason === "change" || reason === "heartbeat");
            const computed = previous ? changePercent(signature, previous) : 100;
            frames.push({
                path,
                displayId: row.displayId,
                frame: {
                    changePercent: row.changePercent && row.changePercent > 0 ? row.changePercent : computed,
                    reason,
                    ...(comparable && previous
                        ? { motionBoxes: reason === "change" ? motionBoxes(signature, previous) : [] }
                        : {}),
                },
            });
            previous = signature;
        }

        sequences.push(frames);
    }

    return sequences;
}

async function helperPid(): Promise<number | null> {
    const rows = await listPsTable();
    return rows.find((row) => row.ppid === process.pid && /darwinkit/i.test(row.command))?.pid ?? null;
}

function helperCpuMs(pid: number | null): number {
    return pid === null ? 0 : (parseCpuTime(captureSync("ps", ["-p", String(pid), "-o", "cputime="]).stdout) ?? 0);
}

function ownCpuMs(): number {
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1000;
}

function lineSet(text: string): Set<string> {
    return new Set(
        text
            .split("\n")
            .map(foldText)
            .filter((line) => line.length > 0)
    );
}

interface ArmTotals {
    frames: number;
    helperCpuMs: number;
    ownCpuMs: number;
    spawns: number;
    skipped: Record<string, number>;
    keptShares: number[];
}

async function main(): Promise<void> {
    const runs = Number(flagValue("--runs") ?? 3);
    const count = Number(flagValue("--frames") ?? 16);
    const meeting = flagValue("--meeting") ?? DEFAULT_MEETING;
    const scratch = flagValue("--scratch") ?? DEFAULT_SCRATCH;
    const sequences = await prepare(meeting, join(scratch, "in"), count);
    const loadBefore = Math.round(loadavg()[0] * 10) / 10;
    const names = Object.keys(ARMS);
    const totals = new Map<string, ArmTotals[]>(names.map((name) => [name, []]));
    const changeShares = sequences.flat().map((one) => one.frame.changePercent);
    const boxShares = sequences
        .flat()
        .filter((one) => one.frame.motionBoxes && one.frame.motionBoxes.length > 0)
        .map((one) => one.frame.motionBoxes?.reduce((sum, [, , w, h]) => sum + w * h, 0) ?? 0);

    closeDarwinKit();
    await recognizeText(sequences[0]?.[0]?.path ?? "", { languages: LANGUAGES });
    const pid = await helperPid();

    for (let run = 0; run < runs; run++) {
        const turned = [...names.slice(run % names.length), ...names.slice(0, run % names.length)];
        const runTotals = new Map<string, ArmTotals>(
            names.map((name) => [
                name,
                { frames: 0, helperCpuMs: 0, ownCpuMs: 0, spawns: 0, skipped: {}, keptShares: [] },
            ])
        );

        for (const sequence of sequences) {
            const rows = new Map<string, OcrRow[]>(names.map((name) => [name, []]));
            const outputs = new Map(
                names.map((name) => {
                    const folder = mkdtempSync(join(scratch, `${name}-`));
                    const output = new FrameOutput({
                        folder,
                        naming: "wall-clock",
                        format: { kind: "jpeg", quality: 0.75 },
                        convert: async (source, target) => copyFileSync(source, target),
                        ocr: {
                            settings: () => ({ enabled: true, languages: LANGUAGES, minChars: 0, ...ARMS[name] }),
                            sink: { write: (row) => rows.get(name)?.push(row) },
                        },
                    });
                    return [name, output] as const;
                })
            );

            for (const [index, one] of sequence.entries()) {
                for (const name of turned) {
                    const output = outputs.get(name) as FrameOutput;
                    const total = runTotals.get(name) as ArmTotals;
                    const helperBefore = helperCpuMs(pid);
                    const ownBefore = ownCpuMs();
                    const counted = await withSpawnCounter(() =>
                        output.keep(
                            { path: one.path, atMs: index * 1_000, ...one.frame },
                            { atMs: Date.UTC(2026, 10, 5, 6, 0, index), originMs: 0, displayId: one.displayId }
                        )
                    );
                    total.helperCpuMs += helperCpuMs(pid) - helperBefore;
                    total.ownCpuMs += ownCpuMs() - ownBefore;
                    total.spawns += counted.count;
                    total.frames += 1;
                }
            }

            const full = rows.get("full") ?? [];

            for (const name of names) {
                const total = runTotals.get(name) as ArmTotals;

                for (const [index, row] of (rows.get(name) ?? []).entries()) {
                    if (row.skipped) {
                        total.skipped[row.skipped] = (total.skipped[row.skipped] ?? 0) + 1;
                    }

                    const want = lineSet(full[index]?.text ?? "");
                    const got = lineSet(row.text);
                    total.keptShares.push(
                        want.size === 0 ? 1 : [...want].filter((line) => got.has(line)).length / want.size
                    );
                }
            }
        }

        for (const name of names) {
            totals.get(name)?.push(runTotals.get(name) as ArmTotals);
        }
    }

    closeDarwinKit();
    const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
    const arms = Object.fromEntries(
        names.map((name) => {
            const list = totals.get(name) ?? [];
            const frames = list[0]?.frames ?? 0;
            const shares = list.flatMap((one) => one.keptShares);
            return [
                name,
                {
                    framesPerRun: frames,
                    helperCpuMsPerFrame: round(median(list.map((one) => one.helperCpuMs / Math.max(1, one.frames)))),
                    ownCpuMsPerFrame: round(median(list.map((one) => one.ownCpuMs / Math.max(1, one.frames)))),
                    spawnsPerFrame: round(median(list.map((one) => one.spawns / Math.max(1, one.frames))), 2),
                    skippedPerRun: list[0]?.skipped ?? {},
                    textKeptPctMean: round(
                        (shares.reduce((sum, value) => sum + value, 0) / Math.max(1, shares.length)) * 100
                    ),
                    textKeptPctMin: round(Math.min(...shares, 1) * 100),
                },
            ];
        })
    );
    const firstSize = sequences[0]?.[0] ? await signatureOf(sequences[0][0].path) : undefined;
    const frameArea = firstSize ? firstSize.pixelWidth * firstSize.pixelHeight : 1;
    const result = {
        runs,
        sequences: sequences.map((one) => one.length),
        changePercentMedian: round(median(changeShares), 2),
        motionBoxAreaPctMedian: round((median(boxShares.length ? boxShares : [0]) / frameArea) * 100, 2),
        load: { before: loadBefore, after: Math.round(loadavg()[0] * 10) / 10 },
        arms,
    };

    if (process.argv.includes("--json")) {
        out.result(result);
        return;
    }

    out.println(SafeJSON.stringify(result, null, 2));
}

await main();
process.exit(0);
