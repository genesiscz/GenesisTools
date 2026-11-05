#!/usr/bin/env bun
/**
 * The meeting recorder's per-frame keep path, before and after it moved into the shared frame output
 * (`@genesiscz/utils/screen-recorder/frame-output`): a PNG from the capture becomes a JPEG (`sips`), Vision OCR reads
 * it, and one `ocr.jsonl` row is appended.
 *
 * Arms, interleaved per frame (A B A B ...), fresh output folders per run:
 *   - inline: the body of the old `keepFrames` in src/meetings/lib/recorder.ts (sipsJpeg, recognizeText, appendFileSync,
 *     statSync), copied here unchanged.
 *   - shared: `FrameOutput.keep` with a `JsonlOcrSink`, as the recorder calls it now.
 *
 * Metrics per arm (medians over every frame of every run): wall ms, this process's CPU ms, the darwinkit helper's CPU
 * ms (`ps cputime`, 10 ms resolution), spawned children per frame. The check value is the OCR text length, which must
 * agree between the arms frame by frame.
 *
 * Input: 10 frames of a meeting (every 50th JPEG of `frames/`), turned into PNGs once under the scratch folder; the
 * meeting is only read.
 *
 * Usage: bun scripts/benchmarks/meetings-ocr/keep.ts [--runs 3] [--meeting <folder>] [--scratch <dir>] [--json]
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { withSpawnCounter } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { recognizeText } from "@genesiscz/utils/macos/ocr";
import { captureSync, listPsTable, parseCpuTime } from "@genesiscz/utils/process/ps";
import { FrameOutput, JsonlOcrSink, sipsJpeg, wallClockFrameName } from "@genesiscz/utils/screen-recorder/frame-output";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { median } from "../fs/shared";

const DEFAULT_MEETING = genesisToolsDir("meetings", "2026-11-04_16-32-meeting");
const DEFAULT_SCRATCH = join(tmpdir(), "meetings-ocr-bench", "keep");
const LANGUAGES = ["en-US"];
const QUALITY = 0.8;

function flagValue(flag: string): string | undefined {
    const at = process.argv.indexOf(flag);
    return at > 0 ? process.argv[at + 1] : undefined;
}

async function preparePngs(meeting: string, scratch: string): Promise<string[]> {
    const source = join(meeting, "frames");
    const names = readdirSync(source)
        .filter((name) => name.endsWith(".jpg"))
        .sort()
        .filter((_, index) => index % 50 === 0)
        .slice(0, 10);
    const dir = join(scratch, "png");
    mkdirSync(dir, { recursive: true });
    const pngs: string[] = [];

    for (const name of names) {
        const png = join(dir, name.replace(/\.jpg$/, ".png"));

        if (!existsSync(png)) {
            const proc = Bun.spawn(["sips", "-s", "format", "png", join(source, name), "--out", png], {
                stdout: "ignore",
                stderr: "ignore",
            });
            await proc.exited;
        }

        pngs.push(png);
    }

    return pngs;
}

function ownCpuMs(): number {
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1000;
}

function helperCpuMs(pid: number | null): number {
    if (pid === null) {
        return 0;
    }

    return parseCpuTime(captureSync("ps", ["-p", String(pid), "-o", "cputime="]).stdout) ?? 0;
}

async function helperPid(): Promise<number | null> {
    const rows = await listPsTable();
    return rows.find((row) => row.ppid === process.pid && /darwinkit/i.test(row.command))?.pid ?? null;
}

/** The old keepFrames body for one frame. */
async function inlineKeep(png: string, folder: string, at: Date): Promise<number> {
    const name = wallClockFrameName(at, 1);
    const jpg = join(folder, "frames", name);
    mkdirSync(join(folder, "frames"), { recursive: true });
    await sipsJpeg(png, jpg, QUALITY);
    const read = await recognizeText(jpg, { languages: LANGUAGES }).catch(() => ({ text: "", blocks: [] }));
    appendFileSync(
        join(folder, "ocr.jsonl"),
        `${SafeJSON.stringify({
            file: `frames/${name}`,
            at: at.toISOString(),
            displayId: 1,
            changePercent: 5,
            reason: "change",
            text: read.text,
            blocks: read.blocks.map((block) => ({
                text: block.text,
                confidence: block.confidence,
                bounds: block.bounds,
            })),
        })}\n`
    );
    statSync(jpg);
    return read.text.length;
}

async function sharedKeep(output: FrameOutput, png: string, at: Date): Promise<number> {
    const kept = await output.keep(
        { path: png, atMs: 0, displayId: 1, changePercent: 5, reason: "change" },
        { atMs: at.getTime(), originMs: at.getTime() - 1000, displayId: 1 }
    );
    return kept.read?.text.length ?? 0;
}

interface Sample {
    wallMs: number;
    ownCpuMs: number;
    helperCpuMs: number;
    spawns: number;
    chars: number;
}

async function measure(pid: number | null, fn: () => Promise<number>): Promise<Sample> {
    const helperBefore = helperCpuMs(pid);
    const ownBefore = ownCpuMs();
    const started = performance.now();
    const counted = await withSpawnCounter(fn);
    return {
        wallMs: performance.now() - started,
        ownCpuMs: ownCpuMs() - ownBefore,
        helperCpuMs: helperCpuMs(pid) - helperBefore,
        spawns: counted.count,
        chars: counted.result,
    };
}

async function main(): Promise<void> {
    const runs = Number(flagValue("--runs") ?? 3);
    const meeting = flagValue("--meeting") ?? DEFAULT_MEETING;
    const scratch = flagValue("--scratch") ?? DEFAULT_SCRATCH;
    const pngs = await preparePngs(meeting, scratch);
    await recognizeText(pngs[0] as string, { languages: LANGUAGES });
    const pid = await helperPid();
    const arms: Record<"inline" | "shared", Sample[]> = { inline: [], shared: [] };
    let mismatches = 0;
    // A loaded machine changes the timings and, measured 2026-11-05 at load 178, the OCR text too: print the load.
    const loadBefore = Math.round(loadavg()[0] * 10) / 10;

    for (let run = 0; run < runs; run++) {
        const inlineDir = mkdtempSync(join(scratch, "inline-"));
        const sharedDir = mkdtempSync(join(scratch, "shared-"));
        const output = new FrameOutput({
            folder: sharedDir,
            naming: "wall-clock",
            format: { kind: "jpeg", quality: QUALITY },
            ocr: {
                settings: () => ({ enabled: true, languages: LANGUAGES, minChars: 0 }),
                sink: new JsonlOcrSink(join(sharedDir, "ocr.jsonl")),
            },
        });

        for (const [index, png] of pngs.entries()) {
            const at = new Date(Date.UTC(2026, 10, 4, 15, 0, index));
            const first = run % 2 === 0 ? "inline" : "shared";
            const order: Array<"inline" | "shared"> = first === "inline" ? ["inline", "shared"] : ["shared", "inline"];
            const got: Partial<Record<"inline" | "shared", Sample>> = {};

            for (const arm of order) {
                got[arm] = await measure(pid, () =>
                    arm === "inline" ? inlineKeep(png, inlineDir, at) : sharedKeep(output, png, at)
                );
                arms[arm].push(got[arm] as Sample);
            }

            if (got.inline?.chars !== got.shared?.chars) {
                mismatches += 1;
            }
        }
    }

    const summary = Object.fromEntries(
        Object.entries(arms).map(([arm, samples]) => [
            arm,
            {
                frames: samples.length,
                wallMsMedian: Math.round(median(samples.map((one) => one.wallMs))),
                ownCpuMsMedian: Math.round(median(samples.map((one) => one.ownCpuMs)) * 10) / 10,
                helperCpuMsMedian: median(samples.map((one) => one.helperCpuMs)),
                spawnsPerFrame: median(samples.map((one) => one.spawns)),
            },
        ])
    );
    const result = {
        runs,
        frames: pngs.length,
        mismatches,
        load: { before: loadBefore, after: Math.round(loadavg()[0] * 10) / 10 },
        ...summary,
    };

    if (process.argv.includes("--json")) {
        out.result(result);
        return;
    }

    out.println(SafeJSON.stringify(result, null, 2));
}

await main();
process.exit(0);
