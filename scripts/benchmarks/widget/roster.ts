#!/usr/bin/env bun
/**
 * What one Widget roster update costs: the old way (a new `hub widget discover` process per refresh, every cache
 * cold) against the resident way (the same index refresh inside the long-lived roster worker, caches warm).
 *
 * Arms, interleaved per round (README rule 5), N rounds:
 *   - discoverProcess: spawn `bun src/hub/index.ts widget discover`; child CPU from its rusage.
 *   - residentFull:    `refreshWidgetIndex({all})` + `readWidgetRoster()` in this process.
 *   - residentClaude:  `refreshWidgetIndex({claude})` + read: what one Claude transcript change costs.
 *   - residentRead:    `readWidgetRoster()` only: a listed lead's sub-agent change, and the safety tick.
 * The first in-process read is the cold start and is reported apart (coldReadCpuMs).
 *
 * All arms refresh the real shared history index, exactly as the running Widget does every few seconds.
 *
 *   bun scripts/benchmarks/widget/roster.ts [--runs 5] [--baseline [name]] [--compare [name]] [--parity]
 *
 * `--parity` checks that the resident pipeline shows what the old one showed: old (discover, then read), new
 * (scoped refresh, then read), old again. A row or parent that differs between new and both olds is a parity
 * failure; one that also differs between the two olds is a live session writing during the run.
 */

import { resolve } from "node:path";
import { compareToBaseline, formatComparison, recordBaseline } from "@app/benchmark/lib";
import type { AgentParent } from "@app/hub/lib/agents/types";
import { readWidgetRoster, refreshWidgetIndex, type WidgetRoster } from "@app/hub/lib/widget/roster-index";
import { discoverWidgetCatalog } from "@app/hub/lib/widget/snapshot";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { Command } from "commander";

const NAME = "widget-roster";
const REPO = resolve(import.meta.dir, "../../..");

function cpuMs(start: NodeJS.CpuUsage): number {
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1000;
}

async function inProcess(fn: () => Promise<unknown>): Promise<number> {
    const start = process.cpuUsage();
    await fn();
    return cpuMs(start);
}

async function discoverProcess(): Promise<{ cpuMs: number; rssMb: number }> {
    const proc = Bun.spawn([process.execPath, resolve(REPO, "src/hub/index.ts"), "widget", "discover"], {
        cwd: REPO,
        stdout: "ignore",
        stderr: "ignore",
    });
    await proc.exited;
    const usage = proc.resourceUsage();
    if (!usage) {
        throw new Error("discover subprocess reported no resource usage");
    }

    // bun 1.4 returns these as bigint whatever its types say; Number() reads both.
    return { cpuMs: Number(usage.cpuTime.total) / 1000, rssMb: Number(usage.maxRSS) / 1048576 };
}

function stats(values: number[]): { min: number; median: number; max: number } {
    const sorted = [...values].sort((a, b) => a - b);
    return { min: sorted[0] ?? 0, median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted.at(-1) ?? 0 };
}

function uptime(): string {
    return Bun.spawnSync(["uptime"]).stdout.toString().trim();
}

/** Roster rows and parents by identity, with the volatile build time left out. */
function canonical(roster: WidgetRoster): Map<string, string> {
    const entries = new Map<string, string>();
    for (const row of roster.rows) {
        entries.set(`row:${row.provider}:${row.sessionId}:${row.filePath}`, SafeJSON.stringify(row, { strict: true }));
    }

    const parent = (item: AgentParent) => `parent:${item.provider ?? "claude"}:${item.sessionId}`;
    for (const item of roster.agents.parents) {
        entries.set(parent(item), SafeJSON.stringify(item, { strict: true }));
    }

    entries.set("orphans", SafeJSON.stringify(roster.agents.orphans, { strict: true }));
    return entries;
}

function differing(left: Map<string, string>, right: Map<string, string>): Set<string> {
    const keys = new Set([...left.keys(), ...right.keys()]);
    return new Set([...keys].filter((key) => left.get(key) !== right.get(key)));
}

async function parity(): Promise<void> {
    const readOld = async () => {
        await discoverWidgetCatalog();
        return canonical(await readWidgetRoster());
    };
    const readNew = async () => {
        await refreshWidgetIndex(new Set(["claude", "claude-agents", "codex", "grok"]));
        return canonical(await readWidgetRoster());
    };
    const before = await readOld();
    const resident = await readNew();
    const after = await readOld();
    const live = differing(before, after);
    const broken = [...differing(resident, before)].filter((key) => differing(resident, after).has(key));
    const result = {
        entries: resident.size,
        changedByLiveWrites: live.size,
        parityFailures: broken.filter((key) => !live.has(key)),
        uptime: uptime(),
    };
    out.println(
        `parity: ${result.entries} rows/parents compared, ${result.changedByLiveWrites} changed by live writes, ${result.parityFailures.length} parity failures`
    );
    out.result(result);
    if (result.parityFailures.length > 0) {
        process.exitCode = 1;
    }
}

async function measure(runs: number): Promise<Record<string, number>> {
    const cold = await inProcess(() => readWidgetRoster());
    const arms: Record<string, number[]> = {
        discoverProcess: [],
        residentFull: [],
        residentClaude: [],
        residentRead: [],
    };
    const rss: number[] = [];
    for (let round = 0; round < runs; round++) {
        const spawned = await discoverProcess();
        arms.discoverProcess.push(spawned.cpuMs);
        rss.push(spawned.rssMb);
        arms.residentFull.push(
            await inProcess(async () => {
                await refreshWidgetIndex(new Set(["all"]));
                await readWidgetRoster();
            })
        );
        arms.residentClaude.push(
            await inProcess(async () => {
                await refreshWidgetIndex(new Set(["claude"]));
                await readWidgetRoster();
            })
        );
        arms.residentRead.push(await inProcess(() => readWidgetRoster()));
    }

    renderCliHeader("Widget roster update cost", `CPU ms per update, ${runs} interleaved rounds`);
    const table = createBoxTable(["ARM", "MIN", "MEDIAN", "MAX"]);
    const metrics: Record<string, number> = { coldReadCpuMs: Math.round(cold) };
    for (const [arm, values] of Object.entries(arms)) {
        const { min, median, max } = stats(values);
        table.push([arm, min.toFixed(0), median.toFixed(0), max.toFixed(0)]);
        metrics[`${arm}CpuMs`] = Math.round(median);
    }

    metrics.discoverProcessRssMb = Math.round(stats(rss).median);
    metrics.residentRssMb = Math.round(process.memoryUsage().rss / 1048576);
    out.println(table.toString());
    out.println(
        `cold first read ${metrics.coldReadCpuMs} ms · discover RSS ${metrics.discoverProcessRssMb} MB · resident RSS ${metrics.residentRssMb} MB`
    );
    out.println(uptime());
    return metrics;
}

const program = new Command()
    .name("widget-roster")
    .option("--runs <n>", "Interleaved rounds", (value) => Number(value), 5)
    .option("--baseline [name]", "Record the numbers as a baseline")
    .option("--compare [name]", "Compare against a recorded baseline")
    .option("--parity", "Check that the resident pipeline shows what the discover pipeline showed")
    .action(async (options: { runs: number; baseline?: string | true; compare?: string | true; parity?: boolean }) => {
        if (options.parity) {
            await parity();
            return;
        }

        const metrics = await measure(options.runs);
        const name = (flag: string | true | undefined) => (typeof flag === "string" ? flag : NAME);
        if (options.baseline) {
            await recordBaseline({
                name: name(options.baseline),
                metrics,
                notes: `runs=${options.runs} | ${uptime()}`,
            });
        }

        if (options.compare) {
            const comparison = await compareToBaseline({
                name: name(options.compare),
                metrics,
                tolerancePct: 50,
                lowerIsBetter: Object.keys(metrics),
                floor: { residentReadCpuMs: 50, residentClaudeCpuMs: 50, residentFullCpuMs: 100 },
            });
            out.println(formatComparison(comparison));
            if (!comparison.ok) {
                process.exitCode = 1;
            }
        }

        out.result(metrics);
    });

await program.parseAsync();
