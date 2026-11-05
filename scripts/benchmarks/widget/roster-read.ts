#!/usr/bin/env bun
/**
 * What one widget roster read costs: `readWidgetRoster()`, the agents tree and the session rows the widget watch reads
 * on every roster change and safety tick (the hub's agents list reads the same tree). Reads are spaced, because a live
 * session appends between them, and an append is what the caches must survive: back-to-back reads find everything
 * cached and measure nothing real. Two reads warm the caches first.
 *
 * The metric is CPU per read (median); the check value is the row and parent counts, which must agree between the
 * arms of a comparison (live data moves, so a few rows of difference between runs minutes apart is expected). It only
 * reads: the session transcripts, the history index (read-only), the pin journal and the widget's roster cache.
 *
 *   bun scripts/benchmarks/widget/roster-read.ts [--runs 5] [--gap-ms 8000] [--baseline [name]] [--compare [name]]
 *       [--record-run <change>] [--json]
 *
 * `--record-run` appends this run to the baseline's history with HEAD's commit and the change it measures.
 */

import { compareToBaseline, formatComparison, recordBaseline, recordRun } from "@app/benchmark/lib";
import { readWidgetRoster } from "@app/hub/lib/widget/roster-index";
import { runTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command, InvalidArgumentError } from "commander";

const NAME = "widget-roster-read";

function count(minimum: number) {
    return (value: string): number => {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < minimum) {
            throw new InvalidArgumentError(`a whole number of ${minimum} or more`);
        }

        return parsed;
    };
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function uptime(): string {
    return Bun.spawnSync(["uptime"]).stdout.toString().trim();
}

const program = new Command()
    .name("widget-roster-read-bench")
    .option("--runs <n>", "measured reads", count(1), 5)
    .option("--gap-ms <ms>", "the pause before each measured read", count(0), 8000)
    .option("--baseline [name]", "record the result as a baseline")
    .option("--compare [name]", "compare the result with a baseline")
    .option("--record-run <change>", "append this run to the baseline's history, naming the change it measures")
    .option("--json", "print the metrics and the check value as JSON")
    .action(
        async (options: {
            runs: number;
            gapMs: number;
            baseline?: string | true;
            compare?: string | true;
            recordRun?: string;
            json?: boolean;
        }) => {
            const loadBefore = uptime();
            for (let index = 0; index < 2; index++) {
                await readWidgetRoster();
            }

            const cpu: number[] = [];
            const wall: number[] = [];
            let check = "";
            for (let index = 0; index < options.runs; index++) {
                if (options.gapMs > 0) {
                    await Bun.sleep(options.gapMs);
                }

                const start = process.cpuUsage();
                const startedAt = performance.now();
                const roster = await readWidgetRoster();
                wall.push(performance.now() - startedAt);
                const used = process.cpuUsage(start);
                cpu.push((used.user + used.system) / 1000);
                check = `rows=${roster.rows.length} parents=${roster.agents.parents.length}`;
            }

            const metrics = { rosterReadCpuMs: median(cpu), rosterReadWallMs: median(wall) };
            if (options.json) {
                out.println(SafeJSON.stringify({ metrics, cpu, check, loadBefore, loadAfter: uptime() }) ?? "");
            } else {
                out.println(
                    [
                        `cpu per read ms: ${cpu.map((value) => value.toFixed(0)).join(" ")} (median ${metrics.rosterReadCpuMs.toFixed(0)})`,
                        `wall per read ms: ${wall.map((value) => value.toFixed(0)).join(" ")} (median ${metrics.rosterReadWallMs.toFixed(0)})`,
                        `check: ${check}`,
                        `load before: ${loadBefore}`,
                        `load after: ${uptime()}`,
                    ].join("\n")
                );
            }

            const name = (value: string | true) => (value === true ? NAME : value);
            const notes = `runs=${options.runs} gap=${options.gapMs}ms | ${check} | Bun ${Bun.version} | ${uptime()}`;
            if (options.baseline) {
                await recordBaseline({ name: name(options.baseline), metrics, notes });
            }

            if (options.compare) {
                const comparison = await compareToBaseline({
                    name: name(options.compare),
                    metrics,
                    tolerancePct: 50,
                    lowerIsBetter: Object.keys(metrics),
                });
                out.log.info(formatComparison(comparison));
                if (!comparison.ok) {
                    process.exitCode = 1;
                }
            }

            if (options.recordRun) {
                const target = options.compare ? name(options.compare) : NAME;
                await recordRun({ name: target, metrics, change: options.recordRun, notes });
            }
        }
    );

await runTool(program, { tool: "benchmark" });
