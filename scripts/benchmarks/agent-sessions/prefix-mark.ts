#!/usr/bin/env bun
/**
 * What the prefix check of an append-only transcript scan costs: `readPrefixMark(fd, offset)` over the largest
 * Claude transcripts, each call at another offset, so every call misses the mark cache and hashes the whole prefix,
 * as a resumed scan does after every append of a live session. The hub agents tree and the widget roster run it for
 * each live parent and sub-agent transcript on every read, so a 200 MB live session costs this on every refresh.
 *
 * The metric is CPU per MB hashed (median of the runs); the check value is the file count and the MB, which must
 * agree between the arms of a comparison. It only reads the transcripts.
 *
 *   bun scripts/benchmarks/agent-sessions/prefix-mark.ts [--files 3] [--runs 7] [--baseline [name]] [--compare [name]]
 */

import { closeSync, openSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareToBaseline, formatComparison, recordBaseline } from "@app/benchmark/lib";
import { readPrefixMark } from "@genesiscz/utils/ai/transcripts/file-scan";
import { runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Command, InvalidArgumentError } from "commander";

const NAME = "prefix-mark";

function wholeNumber(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new InvalidArgumentError("a whole number of 1 or more");
    }

    return parsed;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function uptime(): string {
    return Bun.spawnSync(["uptime"]).stdout.toString().trim();
}

/** The largest top-level transcripts of every Claude project folder. */
function largestTranscripts(count: number): Array<{ path: string; size: number }> {
    const root = join(homedir(), ".claude", "projects");
    const found: Array<{ path: string; size: number }> = [];
    for (const project of readdirSync(root, { withFileTypes: true })) {
        if (!project.isDirectory()) {
            continue;
        }

        for (const entry of readdirSync(join(root, project.name), { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                const path = join(root, project.name, entry.name);
                found.push({ path, size: statSync(path).size });
            }
        }
    }

    return found.sort((a, b) => b.size - a.size).slice(0, count);
}

const program = new Command()
    .name("prefix-mark-bench")
    .option("--files <n>", "largest transcripts to hash", wholeNumber, 3)
    .option("--runs <n>", "measured passes over the files", wholeNumber, 7)
    .option("--baseline [name]", "record the result as a baseline")
    .option("--compare [name]", "compare the result with a baseline")
    .action((options: { files: number; runs: number; baseline?: string | true; compare?: string | true }) => {
        const files = largestTranscripts(options.files);
        const loadBefore = uptime();
        const cpuPerMb: number[] = [];
        let megabytes = 0;
        for (let run = 0; run <= options.runs; run++) {
            const start = process.cpuUsage();
            megabytes = 0;
            for (const file of files) {
                const fd = openSync(file.path, "r");
                try {
                    // Another offset each run: the cache never answers, every call hashes the prefix.
                    const offset = Math.max(0, file.size - 1 - run);
                    readPrefixMark(fd, offset).finish();
                    megabytes += offset / 1_048_576;
                } finally {
                    closeSync(fd);
                }
            }

            const used = process.cpuUsage(start);
            if (run > 0) {
                cpuPerMb.push((used.user + used.system) / 1000 / megabytes);
            }
        }

        const metrics = { prefixCpuMsPerMb: median(cpuPerMb) };
        const check = `files=${files.length} mb=${megabytes.toFixed(0)}`;
        out.println(
            [
                `files: ${files.map((file) => `${(file.size / 1_048_576).toFixed(0)} MB`).join(", ")} (Bun ${Bun.version})`,
                `cpu per MB ms: ${cpuPerMb.map((value) => value.toFixed(3)).join(" ")} (median ${metrics.prefixCpuMsPerMb.toFixed(3)})`,
                `per pass: ${(metrics.prefixCpuMsPerMb * megabytes).toFixed(0)} ms for ${megabytes.toFixed(0)} MB`,
                `check: ${check}`,
                `load before: ${loadBefore}`,
                `load after: ${uptime()}`,
            ].join("\n")
        );

        const name = (value: string | true) => (value === true ? NAME : value);
        return (async () => {
            if (options.baseline) {
                await recordBaseline({
                    name: name(options.baseline),
                    metrics,
                    notes: `runs=${options.runs} | ${check} | Bun ${Bun.version} | ${uptime()}`,
                });
            }

            if (options.compare) {
                const comparison = await compareToBaseline({
                    name: name(options.compare),
                    metrics,
                    tolerancePct: 50,
                    lowerIsBetter: Object.keys(metrics),
                });
                out.println(formatComparison(comparison));
            }
        })();
    });

await runTool(program, { tool: "benchmark" });
