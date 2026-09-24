#!/usr/bin/env bun
import { join } from "node:path";
// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/scripts/perf-report.ts at 2026-09-24T04:59:16+02:00 at commit hash 0d268a43e86e6e5e0ce16132aed8c862e201923e
/**
 * perf-report.ts — summarise `~/.genesis/logs/perf.log` (PerfLog + MonitorPerf).
 *
 *   bun scripts/perf-report.ts               # whole file
 *   bun scripts/perf-report.ts --tail 20000  # last N lines
 *   bun scripts/perf-report.ts --min 500     # only labels whose p95 >= 500 ms
 *
 * Prints per-label count / p50 / p95 / max, the main-thread stall ladder
 * (`main-stall recovered after …`) and every `TIMEOUT` / hang-sample mark, so
 * "what was slow today" is one command instead of an awk session.
 */
import { env } from "@genesiscz/utils/env";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
// GenesisTools adaptation: GenesisTools.app's PerfLog file; the whole file is biome-formatted (block ifs).
const file = flag("--file") ?? join(env.tools.getHome(), ".genesis-tools", "logs", "app-perf.log");
const tail = Number(flag("--tail") ?? 0);
const minP95 = Number(flag("--min") ?? 0);

let lines = (await Bun.file(file).text()).split("\n");
if (tail > 0) {
    lines = lines.slice(-tail);
}

const spans = new Map<string, number[]>();
const stalls: number[] = [];
const marks: string[] = [];
const spanRe = /^\[(\d\d:\d\d:\d\d\.\d+)\] (\S+) ([\d.]+)ms$/;
const stallRe = /main-stall recovered after (\d+)ms/;

for (const line of lines) {
    const m = spanRe.exec(line);
    if (m) {
        const list = spans.get(m[2]) ?? [];
        list.push(Number(m[3]));
        spans.set(m[2], list);
        continue;
    }
    const s = stallRe.exec(line);
    if (s) {
        stalls.push(Number(s[1]));
        continue;
    }
    if (/TIMEOUT|sampling to|sample failed|main-stall ongoing/.test(line)) {
        marks.push(line);
    }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const rows = [...spans.entries()]
    .map(([label, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
            label,
            n: sorted.length,
            p50: pct(sorted, 0.5),
            p95: pct(sorted, 0.95),
            max: sorted[sorted.length - 1],
        };
    })
    .filter((r) => r.p95 >= minP95)
    .sort((a, b) => b.p95 - a.p95);

const fmt = (v: number) => v.toFixed(v >= 100 ? 0 : 1).padStart(9);
console.log(`perf.log: ${file} (${lines.length} lines${tail ? `, last ${tail}` : ""})\n`);
console.log(
    `${"label".padEnd(44)} ${"n".padStart(6)} ${"p50 ms".padStart(9)} ${"p95 ms".padStart(9)} ${"max ms".padStart(9)}`
);
for (const r of rows) {
    console.log(`${r.label.padEnd(44)} ${String(r.n).padStart(6)} ${fmt(r.p50)} ${fmt(r.p95)} ${fmt(r.max)}`);
}

if (stalls.length) {
    const sorted = [...stalls].sort((a, b) => a - b);
    const buckets: [string, number][] = [
        ["0.5-1s", sorted.filter((v) => v < 1000).length],
        ["1-2s", sorted.filter((v) => v >= 1000 && v < 2000).length],
        ["2-5s", sorted.filter((v) => v >= 2000 && v < 5000).length],
        ["5s+", sorted.filter((v) => v >= 5000).length],
    ];
    console.log(
        `\nmain-thread stalls: ${stalls.length} (p50 ${pct(sorted, 0.5)} ms, max ${sorted[sorted.length - 1]} ms)`
    );
    for (const [name, n] of buckets) {
        console.log(`  ${name.padEnd(8)} ${n}`);
    }
} else {
    console.log("\nmain-thread stalls: none");
}

if (marks.length) {
    console.log(`\nmarks (${marks.length}, last 20):`);
    for (const m of marks.slice(-20)) {
        console.log(`  ${m}`);
    }
}
