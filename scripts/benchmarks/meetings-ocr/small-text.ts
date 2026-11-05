#!/usr/bin/env bun
/**
 * Which OCR read finds the small text of a kept frame, and at what CPU. A whole-frame read of a wide 1x display
 * (3440×1440 kept at 2880×1205) finds about 14 lines where a read of each half finds about 300.
 *
 * Input: `--frames` consecutive kept frames of each display of one meeting (from the middle of its `ocr.jsonl`), copied
 * into the scratch folder; the meeting is only read, and no text leaves this process (the output holds counts only).
 *
 * Arms, interleaved per frame (the order turned per frame and run):
 *   - Vision arms run in one long-lived Swift process (`small-text-arms.swift`, built once into the scratch folder),
 *     one job per read; CPU is that process's getrusage over the job. `whole` uses darwinkit's settings (accurate,
 *     language correction on, the meeting's languages). A tile arm reads the frame in `tiles` vertical strips, left to
 *     right, each `OVERLAP` of the width wider on its inner sides, as regions of interest of one image.
 *   - `darwinkit-whole` and `changed` are the recorder's own path (`FrameOutput` with `region` "frame" or "changed",
 *     the shared darwinkit helper): the positive control for `whole`, and the existing changed-area read.
 *   - `darwinkit-tiles` uses FrameOutput and recognizeText with read: tiles: the shipped aspect-ratio rule, native
 *     regions, correction off, and spatial overlap deduplication, through darwinkit 0.8.1.
 *   - `tiles-2-crops` is how a tile read would ship without a new native binary: `sips` crops each tile to a PNG and
 *     darwinkit reads each crop.
 *   CPU per frame for the darwinkit arms is the helper's `ps cputime` (10 ms resolution) plus the CPU of the `sips`
 *   children (their resource usage), so it is comparable with the Swift arms only to about 10 ms.
 *
 * The reference is `halves`: a read of the left half and a read of the right half (no overlap), with today's settings,
 * from the first run. Two recalls per arm, the mean over frames and runs:
 *   - `recallPct`: the share of the reference's lines (folded, each once) that the arm's read holds, the same or with a
 *     bigram similarity of 0.8 or more. It undercounts: Vision splits a text into lines differently per crop.
 *   - `wordRecallPct`: the share of the reference's words (a multiset) that the arm's read holds.
 * `poolWordRecallPct` (first run only) is the share of every word any arm read in the frame.
 *
 * Usage: bun scripts/benchmarks/meetings-ocr/small-text.ts [--runs 3] [--frames 8] [--displays 2,1,4]
 *        [--meeting <folder>] [--scratch <dir>] [--languages cs-CZ,en-US] [--json]
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { withSpawnCounter } from "@app/benchmark/lib";
import { defaultOcrLanguages } from "@app/meetings/lib/recorder-shared";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { closeDarwinKit } from "@genesiscz/utils/macos/darwinkit";
import { type OcrRead, recognizeText } from "@genesiscz/utils/macos/ocr";
import { imageSize, type PixelBox } from "@genesiscz/utils/macos/ocr-boxes";
import { OCR_READ_DEFAULTS, type OcrRegion } from "@genesiscz/utils/screen-recorder/control";
import { FrameOutput, type ImageCropper, type OcrRow } from "@genesiscz/utils/screen-recorder/frame-output";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import { median } from "../fs/shared";
import {
    type BenchFrame,
    consecutiveFrames,
    flagValue,
    helperCpuMs,
    helperPid,
    keptShare,
    lineSet,
    rowsByDisplay,
} from "./frames";

const DEFAULT_MEETING = genesisToolsDir("meetings", "2026-11-04_16-32-meeting");
const DEFAULT_SCRATCH = join(tmpdir(), "meetings-ocr-bench", "small-text");
/** How much wider than its share of the width each tile is on an inner side: a line cut by a tile edge is whole in one. */
const OVERLAP = 0.03;

type VisionArm = {
    kind: "vision";
    level: "accurate" | "fast";
    correction: boolean;
    minimumTextHeight?: number;
    tiles?: number;
    overlap?: number;
};
type Arm = VisionArm | { kind: "output"; region: OcrRegion; read?: OcrRead } | { kind: "crops"; tiles: number };

const today = { kind: "vision", level: "accurate", correction: true } as const satisfies VisionArm;

const ARMS: Record<string, Arm> = {
    whole: today,
    "mth-0.02": { ...today, minimumTextHeight: 0.02 },
    "mth-0.01": { ...today, minimumTextHeight: 0.01 },
    "mth-0.005": { ...today, minimumTextHeight: 0.005 },
    "no-correction": { ...today, correction: false },
    fast: { ...today, level: "fast" },
    "tiles-2": { ...today, tiles: 2 },
    "tiles-3": { ...today, tiles: 3 },
    "tiles-2-no-correction": { ...today, tiles: 2, correction: false },
    "tiles-3-no-correction": { ...today, tiles: 3, correction: false },
    halves: { ...today, tiles: 2, overlap: 0 },
    "darwinkit-whole": { kind: "output", region: "frame" },
    "darwinkit-tiles": { kind: "output", region: "frame", read: "tiles" },
    changed: { kind: "output", region: "changed" },
    "tiles-2-crops": { kind: "crops", tiles: 2 },
};
const REFERENCE = "halves";
/**
 * One job of the Swift process ends within this. A cold Vision model load took 29 s on this Mac, and one waited in
 * the text recognizer for over 4 minutes (2026-11-05 08:24) while darwinkit loaded the same models.
 */
const JOB_TIMEOUT_MS = 180_000;

/** Vertical strips, left to right, as normalized top-left boxes. */
function tileBoxes(tiles: number, overlap = OVERLAP): number[][] {
    return Array.from({ length: tiles }, (_, index) => {
        const left = Math.max(0, index / tiles - (index > 0 ? overlap : 0));
        const right = Math.min(1, (index + 1) / tiles + (index < tiles - 1 ? overlap : 0));
        return [left, 0, right - left, 1];
    });
}

const readySchema = z.object({ ready: z.boolean(), defaultMinimumTextHeight: z.number(), revision: z.number() });
const answerSchema = z.object({
    id: z.number(),
    cpuMs: z.number(),
    wallMs: z.number(),
    lines: z.array(z.object({ text: z.string() })),
    error: z.string().optional().nullable(),
});
type Answer = z.infer<typeof answerSchema>;

/** The Swift arms process: one JSON job per line in, one JSON answer per line out. */
class VisionArms {
    private buffer = "";
    private nextId = 0;
    private readonly decoder = new TextDecoder();
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

    private constructor(private readonly proc: Bun.Subprocess<"pipe", "pipe", "inherit">) {
        this.reader = proc.stdout.getReader();
    }

    static async start(binary: string): Promise<{ arms: VisionArms; ready: z.infer<typeof readySchema> }> {
        const arms = new VisionArms(Bun.spawn([binary], { stdin: "pipe", stdout: "pipe", stderr: "inherit" }));
        return { arms, ready: readySchema.parse(SafeJSON.parse(await arms.line(), { strict: true })) };
    }

    private async line(): Promise<string> {
        while (!this.buffer.includes("\n")) {
            const { value, done } = await this.reader.read();

            if (done) {
                throw new Error("small-text-arms ended before it answered");
            }

            this.buffer += this.decoder.decode(value, { stream: true });
        }

        const end = this.buffer.indexOf("\n");
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        return line;
    }

    async read(path: string, arm: VisionArm, languages: string[]): Promise<Answer> {
        const id = ++this.nextId;
        const job = {
            id,
            path,
            level: arm.level,
            correction: arm.correction,
            languages,
            ...(arm.minimumTextHeight === undefined ? {} : { minimumTextHeight: arm.minimumTextHeight }),
            ...(arm.tiles ? { regions: tileBoxes(arm.tiles, arm.overlap) } : {}),
        };
        this.proc.stdin.write(`${SafeJSON.stringify(job)}\n`);
        this.proc.stdin.flush();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`small-text-arms did not answer job ${id} within ${JOB_TIMEOUT_MS / 1000} s`)),
                JOB_TIMEOUT_MS
            );
        });
        const raw = await Promise.race([this.line(), deadline]).finally(() => clearTimeout(timer));
        const answer = answerSchema.parse(SafeJSON.parse(raw, { strict: true }));

        if (answer.id !== id) {
            throw new Error(`small-text-arms answered job ${answer.id} for job ${id}`);
        }

        return answer;
    }

    async close(): Promise<void> {
        this.proc.stdin.end();
        await this.proc.exited;
    }

    /** Stops a process that may hang in Vision, so a failed bench leaves no child behind. */
    kill(): void {
        this.proc.kill();
    }
}

async function buildArms(scratch: string): Promise<string> {
    const source = join(moduleDir(import.meta), "small-text-arms.swift");
    const binary = join(scratch, "small-text-arms");

    if (existsSync(binary) && statSync(binary).mtimeMs >= statSync(source).mtimeMs) {
        return binary;
    }

    const proc = Bun.spawn(["swiftc", "-O", source, "-o", binary], { stdout: "inherit", stderr: "inherit" });

    if ((await proc.exited) !== 0) {
        throw new Error("swiftc failed for small-text-arms.swift");
    }

    return binary;
}

/** The CPU of every `sips` this bench starts, in ms. */
let sipsCpuMs = 0;

/** `sipsCrop`'s command, with the child's CPU counted. */
const countedCrop: ImageCropper = async (source, target, box) => {
    const proc = Bun.spawn(
        [
            "sips",
            "-s",
            "format",
            "png",
            "-c",
            String(box.height),
            String(box.width),
            "--cropOffset",
            String(box.y),
            String(box.x),
            source,
            "--out",
            target,
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    const status = await proc.exited;
    // Bun types it as a number and answers a bigint (µs).
    sipsCpuMs += Number(proc.resourceUsage()?.cpuTime.total ?? 0) / 1000;

    if (status !== 0) {
        throw new Error(`sips crop failed for ${source}`);
    }
};

interface Sample {
    cpuMs: number;
    wallMs: number;
    spawns: number;
    lines: Set<string>;
}

interface Context {
    languages: string[];
    vision: VisionArms;
    helper: number | null;
    scratch: string;
}

async function measured(read: () => Promise<{ text: string }>, helper: number | null): Promise<Sample> {
    const helperBefore = helperCpuMs(helper);
    const sipsBefore = sipsCpuMs;
    const wallBefore = performance.now();
    const counted = await withSpawnCounter(read);
    return {
        cpuMs: helperCpuMs(helper) - helperBefore + (sipsCpuMs - sipsBefore),
        wallMs: performance.now() - wallBefore,
        spawns: counted.count,
        lines: lineSet(counted.result.text),
    };
}

/** One tile read the way it would ship: a `sips` crop per tile, each read by darwinkit. */
async function cropRead(path: string, tiles: number, context: Context): Promise<{ text: string }> {
    const size = imageSize(path);
    const texts: string[] = [];

    for (const [index, [left, , width]] of tileBoxes(tiles).entries()) {
        const box: PixelBox = {
            x: Math.round((left ?? 0) * size.width),
            y: 0,
            width: Math.round((width ?? 1) * size.width),
            height: size.height,
        };
        const crop = join(context.scratch, `tile-${process.pid}-${index}.png`);
        await countedCrop(path, crop, box);
        texts.push((await recognizeText(crop, { languages: context.languages, fastFallback: false })).text);
    }

    return { text: texts.join("\n") };
}

async function main(): Promise<void> {
    const runs = Number(flagValue("--runs") ?? 3);
    const count = Number(flagValue("--frames") ?? 8);
    const meeting = flagValue("--meeting") ?? DEFAULT_MEETING;
    const scratch = flagValue("--scratch") ?? DEFAULT_SCRATCH;
    const languages = flagValue("--languages")?.split(",") ?? defaultOcrLanguages();
    const byDisplay = rowsByDisplay(meeting);
    const displayIds = flagValue("--displays")?.split(",").map(Number) ?? [...byDisplay.keys()];
    mkdirSync(scratch, { recursive: true });
    const sequences = await consecutiveFrames({
        meeting,
        scratch: join(scratch, "in"),
        count,
        displays: displayIds.map((id) => byDisplay.get(id) ?? []),
    });
    const names = Object.keys(ARMS);
    const { arms: vision, ready } = await VisionArms.start(await buildArms(scratch));
    /** samples[run][sequence][frame][arm] */
    const samples: Sample[][][][] = [];
    const loads: number[] = [];

    try {
        const firstFrame = sequences[0]?.[0]?.path ?? "";
        // The Swift process loads Vision's models first, then darwinkit: one cold load at a time.
        await vision.read(firstFrame, today, languages);
        closeDarwinKit();
        await recognizeText(firstFrame, { languages });
        const context: Context = { languages, vision, helper: await helperPid(), scratch };
        if (context.helper === null) {
            throw new Error("darwinkit helper not found: CPU measurements would be invalid");
        }

        loads.push(loadavg()[0]);

        for (let run = 0; run < runs; run++) {
            const runSamples: Sample[][][] = [];

            for (const sequence of sequences) {
                const outputs = new Map<string, FrameOutput>();
                const rows = new Map<string, OcrRow[]>();

                for (const name of names) {
                    const arm = ARMS[name];

                    if (arm?.kind === "output") {
                        rows.set(name, []);
                        outputs.set(
                            name,
                            new FrameOutput({
                                folder: mkdtempSync(join(scratch, `${name}-`)),
                                naming: "wall-clock",
                                format: { kind: "jpeg", quality: 0.75 },
                                convert: async (source, target) => copyFileSync(source, target),
                                crop: countedCrop,
                                ocr: {
                                    settings: () => ({
                                        enabled: true,
                                        languages,
                                        minChars: 0,
                                        ...OCR_READ_DEFAULTS,
                                        region: arm.region,
                                        read: arm.read ?? "frame",
                                    }),
                                    sink: { write: (row) => rows.get(name)?.push(row) },
                                },
                            })
                        );
                    }
                }

                const sequenceSamples: Sample[][] = [];

                for (const [index, one] of sequence.entries()) {
                    const turn = (run * 5 + index) % names.length;
                    const order = [...names.slice(turn), ...names.slice(0, turn)];
                    const frameSamples: Sample[] = [];

                    for (const name of order) {
                        frameSamples[names.indexOf(name)] = await readArm({ name, one, index, outputs, rows, context });
                    }

                    loads.push(loadavg()[0]);
                    sequenceSamples.push(frameSamples);
                }

                runSamples.push(sequenceSamples);
            }

            samples.push(runSamples);
            // Keep counts only, so a later native timeout does not discard completed repeats.
            await Bun.write(
                join(scratch, "counts.json"),
                SafeJSON.stringify(summarize({ samples, sequences, names, loads, ready, languages }))
            );
            out.log.info(`run ${run + 1}/${runs} done, load ${loadavg()[0].toFixed(1)}`);
        }
    } catch (error) {
        vision.kill();
        closeDarwinKit();
        throw error;
    }

    await vision.close();
    closeDarwinKit();
    const result = summarize({ samples, sequences, names, loads, ready, languages });

    if (process.argv.includes("--json")) {
        out.result(result);
        return;
    }

    out.println(SafeJSON.stringify(result, null, 2));
}

async function readArm(options: {
    name: string;
    one: BenchFrame;
    index: number;
    outputs: Map<string, FrameOutput>;
    rows: Map<string, OcrRow[]>;
    context: Context;
}): Promise<Sample> {
    const { name, one, index, outputs, rows, context } = options;
    const arm = ARMS[name];

    if (!arm) {
        throw new Error(`no arm ${name}`);
    }

    if (arm.kind === "vision") {
        const answer = await context.vision.read(one.path, arm, context.languages);
        if (answer.error != null) {
            throw new Error(`Vision arm ${name}, frame ${one.path}: ${answer.error}`);
        }
        return {
            cpuMs: answer.cpuMs,
            wallMs: answer.wallMs,
            spawns: 0,
            lines: lineSet(answer.lines.map((line) => line.text).join("\n")),
        };
    }

    if (arm.kind === "crops") {
        return measured(() => cropRead(one.path, arm.tiles, context), context.helper);
    }

    const output = outputs.get(name);

    if (!output) {
        throw new Error(`no frame output for ${name}`);
    }

    return measured(async () => {
        await output.keep(
            { path: one.path, atMs: index * 1_000, ...one.frame },
            { atMs: Date.UTC(2026, 10, 5, 6, 0, index), originMs: 0, displayId: one.displayId }
        );
        return { text: rows.get(name)?.at(-1)?.text ?? "" };
    }, context.helper);
}

/** A read's words (folded lines split on spaces, edge punctuation cut, two characters or more), with their counts. */
function wordBag(lines: Iterable<string>): Map<string, number> {
    const bag = new Map<string, number>();

    for (const line of lines) {
        for (const raw of line.split(" ")) {
            const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

            if (word.length >= 2) {
                bag.set(word, (bag.get(word) ?? 0) + 1);
            }
        }
    }

    return bag;
}

function total(bag: Map<string, number>): number {
    let sum = 0;

    for (const count of bag.values()) {
        sum += count;
    }

    return sum;
}

/**
 * The share of `want`'s words that `got` holds, as multisets. Vision splits a text into lines differently in a crop
 * than in a whole frame, so a line can be read word for word and still not match a line of the other read.
 */
function wordShare(want: Map<string, number>, got: Map<string, number>): number {
    const wanted = total(want);

    if (wanted === 0) {
        return 1;
    }

    let shared = 0;

    for (const [word, count] of want) {
        shared += Math.min(count, got.get(word) ?? 0);
    }

    return shared / wanted;
}

function summarize(options: {
    samples: Sample[][][][];
    sequences: BenchFrame[][];
    names: string[];
    loads: number[];
    ready: z.infer<typeof readySchema>;
    languages: string[];
}) {
    const { samples, sequences, names, loads, ready, languages } = options;
    const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
    const referenceAt = names.indexOf(REFERENCE);
    const displays = sequences.map((sequence, at) => {
        const size = sequence[0] ? imageSize(sequence[0].path) : { width: 0, height: 0 };
        const reference = sequence.map((_, frame) => samples[0]?.[at]?.[frame]?.[referenceAt]?.lines ?? new Set());
        const referenceWords = reference.map((lines) => wordBag(lines));
        // Every word any arm read in the frame (first run), each as often as the arm that read it most often.
        const pool = sequence.map((_, frame) => {
            const all = new Map<string, number>();

            for (const sample of samples[0]?.[at]?.[frame] ?? []) {
                for (const [word, count] of wordBag(sample.lines)) {
                    all.set(word, Math.max(all.get(word) ?? 0, count));
                }
            }

            return all;
        });
        const arms = Object.fromEntries(
            names.map((name, arm) => {
                const perRun = samples.map((run) => run[at]?.map((frame) => frame[arm]) ?? []);
                const all = perRun.flat().filter((sample): sample is Sample => sample !== undefined);
                const recalls = perRun.flatMap((run) =>
                    run.map((sample, frame) => keptShare(reference[frame] ?? new Set(), sample?.lines ?? new Set()))
                );
                const wordRecalls = perRun.flatMap((run) =>
                    run.map((sample, frame) =>
                        wordShare(referenceWords[frame] ?? new Map(), wordBag(sample?.lines ?? new Set()))
                    )
                );
                const poolRecalls = (perRun[0] ?? []).map((sample, frame) =>
                    wordShare(pool[frame] ?? new Map(), wordBag(sample?.lines ?? new Set()))
                );
                const cpuPerRun = perRun.map(
                    (run) => run.reduce((sum, sample) => sum + (sample?.cpuMs ?? 0), 0) / Math.max(1, run.length)
                );
                return [
                    name,
                    {
                        linesMedian: median(all.map((sample) => sample.lines.size)),
                        wordsMedian: median(all.map((sample) => total(wordBag(sample.lines)))),
                        recallPct: round((recalls.reduce((sum, one) => sum + one, 0) / recalls.length) * 100),
                        recallMinPct: round(Math.min(...recalls) * 100),
                        wordRecallPct: round(
                            (wordRecalls.reduce((sum, one) => sum + one, 0) / wordRecalls.length) * 100
                        ),
                        wordRecallMinPct: round(Math.min(...wordRecalls) * 100),
                        poolWordRecallPct: round(
                            (poolRecalls.reduce((sum, one) => sum + one, 0) / Math.max(1, poolRecalls.length)) * 100
                        ),
                        cpuMsPerFrame: round(median(cpuPerRun)),
                        cpuMsPerFrameRuns: cpuPerRun.map((one) => round(one)),
                        wallMsMedian: round(median(all.map((sample) => sample.wallMs))),
                        spawnsPerFrame: round(all.reduce((sum, one) => sum + one.spawns, 0) / all.length, 2),
                    },
                ];
            })
        );
        return {
            displayId: sequence[0]?.displayId,
            size: `${size.width}x${size.height}`,
            frames: sequence.length,
            referenceLinesMedian: median(reference.map((one) => one.size)),
            referenceWordsMedian: median(referenceWords.map(total)),
            poolWordsMedian: median(pool.map(total)),
            arms,
        };
    });
    return {
        runs: samples.length,
        languages,
        vision: { defaultMinimumTextHeight: ready.defaultMinimumTextHeight, revision: ready.revision },
        bun: Bun.version,
        load: {
            first: round(loads[0] ?? 0),
            median: round(median(loads)),
            max: round(Math.max(...loads)),
            last: round(loads.at(-1) ?? 0),
        },
        displays,
    };
}

await main();
process.exit(0);
