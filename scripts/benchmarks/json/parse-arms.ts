#!/usr/bin/env bun
/**
 * Ways of parsing JSONL lines, on the real Claude transcript tails (read-only). Each sample is a fresh process
 * (`parse-child.ts`) that parses the same lines twice: cold (a CLI process) and warm (a resident server). Arms are
 * interleaved. `*.check` (lines parsed) must agree between arms; -1 means the arm is not available here.
 *
 *   jsonParse          native JSON.parse on ready strings
 *   decodeJsonParse    bytes to string, then JSON.parse (what a reader of a file does)
 *   safeJson           SafeJSON.parse with no options (native first, comment-json only for text it rejects)
 *   commentJson        comment-json alone (what SafeJSON.parse did with no options before 2026-10-12)
 *   bunJsonl           Bun.JSONL.parse on the joined text (Bun 1.4 only)
 *   simdjsonFullParse  simdjson through bun:ffi, full parse, no JS objects built: the floor for any C parser
 *   simdjsonPick       simdjson through bun:ffi, only the fields the session listing reads, as numbers
 *
 * Usage:
 *   bun scripts/benchmarks/json/parse-arms.ts --baseline
 *   bun scripts/benchmarks/json/parse-arms.ts --compare
 */
import { join } from "node:path";
import type { BaselineMetrics } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { finishBench, parseBenchArgs } from "../fs/shared";
import { PARSE_ARMS } from "./arms";

const REPO = join(import.meta.dir, "..", "..", "..");

interface Sample {
    coldCpuMs: number;
    warmCpuMs: number;
    check: number;
    lines: number;
}

async function sample(arm: string): Promise<Sample> {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "parse-child.ts"), arm], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [text, errText, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        throw new Error(`parse-child ${arm} exited ${exitCode}: ${errText.slice(0, 500)}`);
    }

    return SafeJSON.parse(text, { strict: true }) as Sample;
}

const args = parseBenchArgs(process.argv.slice(2));
const runs: BaselineMetrics[] = [];

for (let i = 0; i < args.warmup + args.runs; i++) {
    const metrics: BaselineMetrics = {};

    for (const arm of PARSE_ARMS) {
        const { coldCpuMs, warmCpuMs, check, lines } = await sample(arm);
        metrics[`${arm}.cold.cpuMs`] = coldCpuMs;
        metrics[`${arm}.warm.cpuMs`] = warmCpuMs;
        metrics[`${arm}.check`] = check;
        metrics.lines = lines;
    }

    if (i >= args.warmup) {
        runs.push(metrics);
    }
}

const keys = Object.keys(runs[0] ?? {});
await finishBench({
    name: "json-parse-arms",
    title: "Parsing transcript JSONL lines (CPU ms, median; checks must agree, -1 = arm not available)",
    args,
    runs,
    lowerIsBetter: keys.filter((key) => key.endsWith("cpuMs")),
    floor: Object.fromEntries(keys.map((key) => [key, key.endsWith("cpuMs") ? 5 : 50])),
    notes: "live transcript tails, read-only; each sample is a fresh process (cold pass, then warm pass)",
    context: { arms: PARSE_ARMS },
});
