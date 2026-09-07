#!/usr/bin/env bun
/**
 * Interleaved wall-clock benchmark of the `tools macos mail` paths the collector skill leans on.
 * Arms run A,B,C,A,B,C,... so a load change cannot become "the fix". Prints a markdown row per arm
 * (min / median / max, exit codes) for `src/macos/README.md`. Usage:
 *
 *   bun src/macos/lib/mail/bench.ts <label> [rounds=5] [--tools /path/to/tools]
 */
import { loadavg } from "node:os";
import { join } from "node:path";
import { formatDuration } from "@genesiscz/utils/format";

const args = process.argv.slice(2);
const label = args[0] ?? "unlabelled";
const rounds = Number.parseInt(args[1] ?? "5", 10) || 5;
const toolsIdx = args.indexOf("--tools");
const tools = toolsIdx >= 0 ? (args[toolsIdx + 1] ?? "tools") : join(import.meta.dir, "../../../../tools");

const WINDOW = ["--from", "2026-03-01", "--to", "2026-04-01"];
const ARMS: Array<{ name: string; argv: string[] }> = [
    {
        name: "list month, limit 10000",
        argv: ["macos", "mail", "list", ...WINDOW, "--limit", "10000", "--format", "json"],
    },
    {
        name: "search faktura, fulltext, limit 500",
        argv: [
            "macos",
            "mail",
            "search",
            "faktura",
            "--mode",
            "fulltext",
            ...WINDOW,
            "--limit",
            "500",
            "--format",
            "json",
        ],
    },
    {
        name: "search faktura, auto, limit 500",
        argv: ["macos", "mail", "search", "faktura", "--mode", "auto", ...WINDOW, "--limit", "500", "--format", "json"],
    },
];

const samples = new Map<string, Array<{ ms: number; exit: number; err: string }>>(ARMS.map((a) => [a.name, []]));

for (let round = 0; round < rounds; round++) {
    for (const arm of ARMS) {
        const t0 = performance.now();
        const proc = Bun.spawnSync([tools, ...arm.argv], { stdout: "ignore", stderr: "pipe" });
        const ms = performance.now() - t0;
        const err =
            proc.stderr
                .toString()
                .split("\n")
                .find((l) => /error|too large|Error/.test(l)) ?? "";
        samples.get(arm.name)?.push({ ms, exit: proc.exitCode, err });
        process.stderr.write(`round ${round + 1}/${rounds} ${arm.name}: ${formatDuration(ms)} exit ${proc.exitCode}\n`);
    }
}

const [l1, l5] = loadavg();
process.stdout.write(
    `\n### ${label} (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC, load ${l1.toFixed(1)} / ${l5.toFixed(1)}, ${rounds} interleaved rounds)\n\n`
);
process.stdout.write("| Arm | min | median | max | exit codes | first error line |\n|---|---|---|---|---|---|\n");

for (const arm of ARMS) {
    const list = samples.get(arm.name) ?? [];
    const sorted = list.map((s) => s.ms).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const exits = [...new Set(list.map((s) => s.exit))].join(",");
    const err = list.find((s) => s.err)?.err ?? "";
    process.stdout.write(
        `| ${arm.name} | ${formatDuration(sorted[0] ?? 0)} | ${formatDuration(median)} | ${formatDuration(sorted.at(-1) ?? 0)} | ${exits} | ${err.replace(/\|/g, "\\|").slice(0, 90)} |\n`
    );
}
