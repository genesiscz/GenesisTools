#!/usr/bin/env bun
/**
 * What one warm Widget snapshot costs inside the resident watch: `widgetSnapshot` over the roster the last watch
 * cached (rows and agent tree), with every other source real, exactly as `watchWidget` builds it. The watch takes a
 * snapshot for each roster change, inbox write and safety tick, so this is most of its steady CPU (7 to 10% of a
 * core on 2026-11-05: 19.5 s of CPU over 224 s, 42.3 s over 491 s).
 *
 * Two snapshots warm the caches first; then N are measured in this process. The metric is CPU per snapshot (median);
 * the check value is the session count and the snapshot's size, which must agree between the arms of a comparison.
 * It only reads: the roster cache, the widget state, the question database and the decision log.
 *
 *   bun scripts/benchmarks/widget/snapshot.ts [--runs 9] [--baseline [name]] [--compare [name]] [--dump <file>]
 *       [--record-run <change>] [--json]
 *
 * `--record-run` appends this run to the baseline's history with HEAD's commit and the change it measures.
 *
 * `--dump` writes the last snapshot (pretty JSON) for a parity diff between two commits on the same data.
 */

import { compareToBaseline, formatComparison, recordBaseline, recordRun } from "@app/benchmark/lib";
import { readWarmStartRoster } from "@app/hub/lib/widget/roster-cache";
import { realWidgetSources, widgetSnapshot } from "@app/hub/lib/widget/snapshot";
import { runTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command, InvalidArgumentError } from "commander";

const NAME = "widget-snapshot";

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function uptime(): string {
    return Bun.spawnSync(["uptime"]).stdout.toString().trim();
}

const program = new Command()
    .name("widget-snapshot-bench")
    .option(
        "--runs <n>",
        "measured snapshots",
        (value) => {
            const runs = Number(value);
            if (!Number.isInteger(runs) || runs < 1) {
                throw new InvalidArgumentError("a whole number of 1 or more");
            }

            return runs;
        },
        9
    )
    .option("--baseline [name]", "record the result as a baseline")
    .option("--compare [name]", "compare the result with a baseline")
    .option("--dump <file>", "write the last snapshot as JSON")
    .option("--record-run <change>", "append this run to the baseline's history, naming the change it measures")
    .option("--json", "print the metrics and the check value as JSON")
    .action(
        async (options: {
            runs: number;
            baseline?: string | true;
            compare?: string | true;
            dump?: string;
            recordRun?: string;
            json?: boolean;
        }) => {
            const roster = await readWarmStartRoster();
            if (!roster) {
                throw new Error("no widget roster cache to start from: run the widget once (`tools hub widget watch`)");
            }

            const sources = {
                ...realWidgetSources,
                sessions: async () => roster.rows,
                agents: async () => roster.agents,
                rosterStatus: () => ({ loading: false, error: undefined }),
            };
            const take = () => widgetSnapshot({ refresh: false, warm: 16, sources });
            const loadBefore = uptime();
            for (let index = 0; index < 2; index++) {
                await take();
            }

            const cpu: number[] = [];
            const wall: number[] = [];
            let check = "";
            let last: Awaited<ReturnType<typeof take>> | undefined;
            for (let index = 0; index < options.runs; index++) {
                const start = process.cpuUsage();
                const startedAt = performance.now();
                const snapshot = await take();
                last = snapshot;
                wall.push(performance.now() - startedAt);
                const used = process.cpuUsage(start);
                cpu.push((used.user + used.system) / 1000);
                const value = `sessions=${snapshot.sessions.length} bytes=${SafeJSON.stringify(snapshot, { strict: true }).length}`;
                check = check && check !== value ? `${check} (varies: ${value})` : value;
            }

            const metrics = { snapshotCpuMs: median(cpu), snapshotWallMs: median(wall) };
            if (options.json) {
                out.println(SafeJSON.stringify({ metrics, cpu, check, loadBefore, loadAfter: uptime() }) ?? "");
            }

            out.println(
                [
                    `roster: ${roster.rows.length} rows, ${roster.agents.parents.length} parents`,
                    `cpu per snapshot ms: ${cpu.map((value) => value.toFixed(0)).join(" ")} (median ${metrics.snapshotCpuMs.toFixed(0)})`,
                    `wall per snapshot ms: ${wall.map((value) => value.toFixed(0)).join(" ")} (median ${metrics.snapshotWallMs.toFixed(0)})`,
                    `check: ${check}`,
                    `load before: ${loadBefore}`,
                    `load after: ${uptime()}`,
                ].join("\n")
            );
            if (options.dump && last) {
                await Bun.write(options.dump, SafeJSON.stringify(last, null, 2));
            }

            const name = (value: string | true) => (value === true ? NAME : value);
            if (options.baseline) {
                await recordBaseline({
                    name: name(options.baseline),
                    metrics,
                    notes: `runs=${options.runs} | ${check} | ${uptime()}`,
                });
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
                await recordRun({
                    name: options.compare ? name(options.compare) : options.baseline ? name(options.baseline) : NAME,
                    metrics,
                    change: options.recordRun,
                    notes: `runs=${options.runs} | ${check} | ${uptime()}`,
                });
            }
        }
    );

await runTool(program, { tool: "benchmark" });
