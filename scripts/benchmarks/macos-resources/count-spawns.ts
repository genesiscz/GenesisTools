/**
 * Exact spawn count per refresh cycle of `tools macos-resources`.
 *
 * This is the regression gate. `spawn-storm.ts` samples a live process and can
 * only report a floor; this drives the headless core directly under
 * `withSpawnCounter`, so the count is the real number of child processes, with
 * no sampling and no undercount.
 *
 * Two numbers, because the cycles are not alike:
 *
 * - `spawnsFirstCycle`  the cold cycle. Every pid's open-file count is unknown,
 *   so every eligible pid is read: one `ps` plus one `lsof` per 60 pids.
 * - `spawnsSteadyCycle` every later cycle, where only the selected row is due.
 *   This is the number a user actually lives with, and it should be 2.
 *
 * The baseline it records is of the NEW core. There is no "before" for it: the
 * old code had no importable cycle to count, which is why `spawn-storm.ts`
 * exists at all.
 *
 * ```bash
 * bun scripts/benchmarks/macos-resources/count-spawns.ts --cycles 5
 * bun scripts/benchmarks/macos-resources/count-spawns.ts --baseline
 * bun scripts/benchmarks/macos-resources/count-spawns.ts --compare
 * ```
 */

import { parseArgs } from "node:util";
import { compareToBaseline, formatComparison, recordBaseline, withSpawnCounter } from "@app/benchmark/lib";
import {
    type ProcessInfo,
    type RefreshResult,
    runRefreshCycle,
    type SortBy,
} from "@app/macos-resources/lib/process-data";
import { out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";

const BASELINE_NAME = "macos-resources-count-spawns";

interface CycleReport {
    index: number;
    spawns: number;
    processes: number;
    filesRefreshed: number;
    ms: number;
    argv: string[][];
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 1) {
        return sorted[mid];
    }

    return (sorted[mid - 1] + sorted[mid]) / 2;
}

const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        cycles: { type: "string", default: "5" },
        filter: { type: "string", default: "" },
        sort: { type: "string", default: "cpu" },
        name: { type: "string", default: BASELINE_NAME },
        notes: { type: "string" },
        baseline: { type: "boolean", default: false },
        compare: { type: "boolean", default: false },
    },
});

const cycles = Number.parseInt(values.cycles, 10);

if (!Number.isFinite(cycles) || cycles < 2) {
    out.printlnErr("--cycles must be at least 2, so a steady-state cycle can be told from the cold one.");
    process.exit(1);
}

let previous: ProcessInfo[] = [];
let lastFilesUpdate = new Map<number, number>();
let selectedPid: number | null = null;
const reports: CycleReport[] = [];

for (let index = 0; index < cycles; index++) {
    const startedAt = performance.now();
    const before = lastFilesUpdate;
    const counted = await withSpawnCounter<RefreshResult>(() =>
        runRefreshCycle({
            filter: values.filter,
            sortBy: values.sort as SortBy,
            previous,
            lastFilesUpdate,
            selectedPid,
        })
    );
    const ms = performance.now() - startedAt;
    const result = counted.result;

    let filesRefreshed = 0;

    for (const [pid, at] of result.lastFilesUpdate) {
        if (before.get(pid) !== at) {
            filesRefreshed++;
        }
    }

    previous = result.processes;
    lastFilesUpdate = result.lastFilesUpdate;
    selectedPid = result.processes[0]?.pid ?? null;

    reports.push({
        index,
        spawns: counted.count,
        processes: result.processes.length,
        filesRefreshed,
        ms,
        argv: counted.spawns.map((record) => record.cmd),
    });
}

const steady = reports.slice(1);
const metrics = {
    spawnsFirstCycle: reports[0].spawns,
    spawnsSteadyCycle: Math.max(...steady.map((r) => r.spawns)),
    cycleMsSteadyMedian: median(steady.map((r) => r.ms)),
};

const rows = reports.map((report) => [
    String(report.index),
    report.index === 0 ? "cold" : "steady",
    String(report.spawns),
    String(report.processes),
    String(report.filesRefreshed),
    report.ms.toFixed(0),
]);

out.println(formatTable(rows, ["CYCLE", "KIND", "SPAWNS", "ROWS", "FILES READ", "MS"], { alignRight: [2, 3, 4, 5] }));
out.println("");
out.println("Every child process of the steady cycle, argv as the kernel received it:");

for (const argv of steady[steady.length - 1].argv) {
    out.println(`  ${argv.join(" ")}`);
}

out.println("");
out.println("No entry above starts with `sh -c`: nothing here goes through a shell.");

if (values.baseline) {
    const notes =
        values.notes ??
        "the NEW headless core; there is no before for this metric because the old code had no importable cycle";
    await recordBaseline({ name: values.name, metrics, notes });
    out.println(`\nRecorded baseline ${values.name}.`);
}

if (values.compare) {
    const cmp = await compareToBaseline({ name: values.name, metrics, tolerancePct: 10 });
    out.println(`\n${formatComparison(cmp)}`);
    process.exitCode = cmp.ok ? 0 : 1;
}

out.result({ metrics, cycles: reports.map(({ argv: _argv, ...rest }) => rest) });
