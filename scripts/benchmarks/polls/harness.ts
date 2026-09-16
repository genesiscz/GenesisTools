/**
 * Shared plumbing for the `scripts/benchmarks/polls/` scripts.
 *
 * Every script here measures ONE polling site, runs the measurement a few times,
 * and reports the per-metric median. The flags are the same everywhere so a
 * reviewer never has to re-read a script to run it:
 *
 * ```
 * bun scripts/benchmarks/polls/<script>.ts              # measure and print
 * bun scripts/benchmarks/polls/<script>.ts --baseline   # record polls-<stem>
 * bun scripts/benchmarks/polls/<script>.ts --compare    # diff against it
 * bun scripts/benchmarks/polls/<script>.ts --json       # machine result
 * ```
 *
 * Every metric these scripts emit is lower-is-better (spawns, reads, stall
 * milliseconds, CPU percent), which is `compareToBaseline`'s default, so none of
 * them pass a `lowerIsBetter` list.
 */
import { type BaselineMetrics, compareToBaseline, formatComparison, recordBaseline } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import type { Command } from "commander";

/** The campaign's agreed tolerance: a fix has to move a metric by more than noise. */
export const TOLERANCE_PCT = 15;

/** Every baseline written from this directory carries the prefix, so `polls-*.json` is one campaign. */
export const BASELINE_PREFIX = "polls-";

export interface CommonFlags {
    baseline?: boolean;
    compare?: boolean;
    json?: boolean;
    runs?: string;
}

/** Register `--baseline`, `--compare`, `--json` and `--runs` on a script's commander program. */
export function addCommonOptions(program: Command): Command {
    return program
        .option("--baseline", "Record the measured median as the baseline for this script")
        .option("--compare", "Measure again and diff against the recorded baseline")
        .option("--json", "Emit the machine-readable result on stdout")
        .option("--runs <n>", "How many measured runs to take the median of", "3");
}

/**
 * The median of an ODD run count is an observed value. For an even count this
 * takes the lower of the two middle samples rather than averaging them, so a
 * recorded baseline is always a number the machine actually produced.
 */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function medianMetrics(runs: BaselineMetrics[]): BaselineMetrics {
    const merged: BaselineMetrics = {};

    for (const metric of Object.keys(runs[0] ?? {})) {
        merged[metric] = median(runs.map((run) => run[metric] ?? 0));
    }

    return merged;
}

function formatCell(value: number): string {
    if (Number.isInteger(value)) {
        return String(value);
    }

    return value.toFixed(2);
}

/** `uptime` output, trimmed, so a suspiciously fast run can be questioned later. */
async function readUptime(): Promise<string> {
    const proc = Bun.spawn(["uptime"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    if (exitCode !== 0) {
        return "uptime unavailable";
    }

    return stdout.trim();
}

export interface PollBenchmark {
    /** Baseline stem; the recorded name becomes `polls-<stem>`. */
    stem: string;
    /** One line naming what the numbers describe. */
    title: string;
    /** What the run measured, appended to the baseline notes. */
    setup: string;
    flags: CommonFlags;
    /** Called once per run; must return the same metric keys every time. */
    measure: (run: number) => Promise<BaselineMetrics>;
}

/**
 * Run the measurement `--runs` times, print the per-run table plus the median,
 * then record or compare. Sets `process.exitCode` to 1 when a comparison fails.
 */
export async function runPollBenchmark(bench: PollBenchmark): Promise<void> {
    const name = `${BASELINE_PREFIX}${bench.stem}`;
    const runCount = Math.max(1, Number.parseInt(bench.flags.runs ?? "3", 10) || 3);
    const runs: BaselineMetrics[] = [];

    for (let run = 0; run < runCount; run++) {
        out.log.info(`${bench.title} — run ${run + 1}/${runCount}`);
        runs.push(await bench.measure(run));
    }

    const metrics = medianMetrics(runs);
    const uptime = await readUptime();
    const headers = ["METRIC", ...runs.map((_, index) => `RUN ${index + 1}`), "MEDIAN"];
    const rows = Object.keys(metrics).map((metric) => [
        metric,
        ...runs.map((run) => formatCell(run[metric] ?? 0)),
        formatCell(metrics[metric] ?? 0),
    ]);
    const alignRight = headers.map((_, index) => index).filter((index) => index > 0);

    out.println(`\n${bench.title}`);
    out.println(bench.setup);
    out.println(uptime);
    out.println("");
    out.println(formatTable(rows, headers, { alignRight }));

    if (bench.flags.baseline) {
        const recorded = await recordBaseline({
            name,
            metrics,
            notes: `${bench.setup} | ${runCount} runs, median | ${uptime}`,
        });
        out.println(`\nRecorded baseline ${name} at commit ${recorded.commit}.`);
        out.println(`Compare later with: bun scripts/benchmarks/polls/${bench.stem}.ts --compare`);
    }

    if (bench.flags.compare) {
        const cmp = await compareToBaseline({ name, metrics, tolerancePct: TOLERANCE_PCT });
        out.println("");
        out.println(formatComparison(cmp));
        process.exitCode = cmp.ok ? 0 : 1;
    }

    if (bench.flags.json) {
        out.result(SafeJSON.stringify({ name, setup: bench.setup, uptime, runs, metrics }, null, 4));
    }
}
