#!/usr/bin/env bun
/**
 * The OCR read savings of the shared frame output (`FrameOutput` with `ocr.threshold`, `ocr.skipTextless` and
 * `ocr.region`),
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
 * (folded lines: the share of the full read's lines that the arm's row holds, the same or with a bigram similarity of
 * at least 0.8). `full-again` reads every frame whole a second time: its share is the floor two whole reads reach.
 *
 * Usage: bun scripts/benchmarks/meetings-ocr/region.ts [--runs 3] [--frames 16] [--meeting <folder>] [--scratch <dir>] [--detail] [--json]
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { withSpawnCounter } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { closeDarwinKit } from "@genesiscz/utils/macos/darwinkit";
import { recognizeText } from "@genesiscz/utils/macos/ocr";
import { OCR_READ_DEFAULTS, type RecorderSettings } from "@genesiscz/utils/screen-recorder/control";
import { FrameOutput, type OcrRow } from "@genesiscz/utils/screen-recorder/frame-output";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { median } from "../fs/shared";
import {
    type BenchFrame,
    consecutiveFrames,
    flagValue,
    helperCpuMs,
    helperPid,
    keptShare,
    lineSet,
    ownCpuMs,
    rowsByDisplay,
} from "./frames";
import { signatureOf } from "./motion";

const DEFAULT_MEETING = genesisToolsDir("meetings", "2026-11-04_16-32-meeting");
const DEFAULT_SCRATCH = join(tmpdir(), "meetings-ocr-bench", "region");
const LANGUAGES = ["en-US"];

type ReadSettings = Pick<RecorderSettings["ocr"], "threshold" | "skipTextless" | "region">;

/** The arms beside `full`. A threshold above `capture.threshold` (2%) is needed to skip anything a capture kept. */
const ARMS: Record<string, ReadSettings> = {
    full: OCR_READ_DEFAULTS,
    // The same settings again: how much two whole reads of one frame differ (Vision's own variance, the noise floor).
    "full-again": OCR_READ_DEFAULTS,
    "threshold-5": { ...OCR_READ_DEFAULTS, threshold: 5 },
    textless: { ...OCR_READ_DEFAULTS, skipTextless: true },
    "threshold-5+textless": { ...OCR_READ_DEFAULTS, threshold: 5, skipTextless: true },
    changed: { ...OCR_READ_DEFAULTS, region: "changed" },
    "changed+textless": { ...OCR_READ_DEFAULTS, region: "changed", skipTextless: true },
};

/** `count` consecutive rows of each of the two busiest displays, from the middle, as frames with motion facts. */
async function prepare(meeting: string, scratch: string, count: number): Promise<BenchFrame[][]> {
    const busiest = [...rowsByDisplay(meeting).values()].sort((a, b) => b.length - a.length).slice(0, 2);
    return consecutiveFrames({ meeting, scratch, count, displays: busiest });
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
    const detail = process.argv.includes("--detail");
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

                    if (row.regions) {
                        total.skipped["area-read"] = (total.skipped["area-read"] ?? 0) + 1;
                    }

                    const want = lineSet(full[index]?.text ?? "");
                    const got = lineSet(row.text);
                    const share = keptShare(want, got);
                    total.keptShares.push(share);

                    // Counts only: the meeting's text never leaves this process.
                    if (detail && run === 0) {
                        const frame = sequence[index];
                        out.println(
                            `${name} d${frame?.displayId} #${index} lines ${want.size}->${got.size} kept ${Math.round(share * 100)}% ` +
                                `change ${frame?.frame.changePercent.toFixed(1)}% boxes ${frame?.frame.motionBoxes?.length ?? "-"} ` +
                                `${row.skipped ?? ""}${row.regions ? `areas ${row.regions.length} (${row.regions.map(([, , w, h]) => w * h).reduce((a, b) => a + b, 0)} px)` : ""}`
                        );
                    }
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
                    notWholePerRun: list[0]?.skipped ?? {},
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
