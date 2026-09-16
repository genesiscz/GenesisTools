/**
 * Shared plumbing for the `scripts/benchmarks/fs/*` regression benchmarks.
 *
 * The three scripts (`tools-watch.ts`, `utils-FileTailer.ts`, `FileWatcher.ts`)
 * all answer the same four questions about a file watcher: what does it burn
 * while nothing happens, how fast does an append reach the consumer, does it
 * still notice the events it is supposed to notice, and does it shut down.
 * Everything that is identical between them lives here.
 *
 * WHY MEDIAN-PER-METRIC AND NOT "the median run". A run produces several
 * unrelated numbers; the run with the median idle CPU is rarely the run with
 * the median append latency, so picking one whole run propagates a single
 * unlucky sample into every metric. `medianMetrics` takes the median of each
 * metric independently across runs, and the per-run table is printed alongside
 * so an outlier is visible rather than hidden.
 */
import { mkdirSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BaselineMetrics, compareToBaseline, formatComparison, recordBaseline } from "@app/benchmark/lib";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";

export interface BenchArgs {
    /** Record the measured metrics as the named baseline. */
    baseline: boolean;
    /** Diff the measured metrics against the recorded baseline and set an exit code. */
    compare: boolean;
    /** Emit the machine-readable result on stdout. */
    json: boolean;
    /** How many full runs to take the per-metric median over. */
    runs: number;
    /**
     * Discarded runs taken before the measured ones. The first run of a bun
     * process pays module load and JIT: FileTailer's idle CPU measured 0.95%
     * on run 1 against 0.30% on run 3 of the same process, which is wider than
     * the 15% comparison tolerance and would make a clean "after" look like a
     * regression. `--warmup 0` turns it off.
     */
    warmup: number;
    /** Dataset size knob; only `tools-watch.ts` uses it. */
    files: number;
}

function numberFlag(argv: string[], flag: string, fallback: number, minimum: number): number {
    const index = argv.indexOf(flag);

    if (index < 0) {
        return fallback;
    }

    const value = Number(argv[index + 1]);

    if (!Number.isFinite(value) || value < minimum) {
        throw new Error(`${flag} needs a number of at least ${minimum}, got "${argv[index + 1] ?? ""}"`);
    }

    return value;
}

export function parseBenchArgs(argv: string[]): BenchArgs {
    return {
        baseline: argv.includes("--baseline"),
        compare: argv.includes("--compare"),
        json: argv.includes("--json"),
        runs: numberFlag(argv, "--runs", 3, 1),
        warmup: numberFlag(argv, "--warmup", 1, 0),
        files: numberFlag(argv, "--files", 20, 1),
    };
}

export function median(values: number[]): number {
    if (values.length === 0) {
        throw new Error("median of an empty sample");
    }

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 1) {
        return sorted[mid] as number;
    }

    return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface SampleSummary {
    min: number;
    median: number;
    max: number;
    n: number;
}

/**
 * min / median / max for a timing sample, per convention 6 in
 * `scripts/benchmarks/README.md`. Only the median is recorded as a baseline
 * metric, because min and max are the least stable statistics and would make
 * the pass/fail gate noisier than the thing it is gating; the full shape goes
 * into the `--json` context so a reader can see the spread behind the median.
 */
export function summarize(values: number[]): SampleSummary {
    return {
        min: Math.min(...values),
        median: median(values),
        max: Math.max(...values),
        n: values.length,
    };
}

/** Per-metric median across runs. Every run must carry the same metric names. */
export function medianMetrics(runs: BaselineMetrics[]): BaselineMetrics {
    if (runs.length === 0) {
        throw new Error("medianMetrics needs at least one run");
    }

    const merged: BaselineMetrics = {};

    for (const metric of Object.keys(runs[0] as BaselineMetrics)) {
        const values = runs.map((run) => {
            const value = run[metric];

            if (value === undefined) {
                throw new Error(`run is missing the metric "${metric}"; every run must measure the same set`);
            }

            return value;
        });
        merged[metric] = median(values);
    }

    return merged;
}

/**
 * A scratch directory under the system temp dir. Deliberately never removed:
 * leaving it costs a few kilobytes and keeps a failed run inspectable, and the
 * repo's rules forbid a delete here.
 */
export function benchTmpDir(label: string): string {
    const dir = join(tmpdir(), "gt-bench-fs", `${label}-${Date.now()}-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Put `fs.watch` into the state a long-lived tailer host is really in, before
 * anything is measured.
 *
 * Measured on bun 1.3.13 / darwin 25.3.0: the FIRST `FSWatcher.close()` in a
 * process leaves every watcher created after it deaf past one event. A watcher
 * created and closed without ever being used is enough to trigger it, and
 * watchers that are all open together are all fine (10 of 10 events each). So
 * a process gets exactly one healthy generation of watchers, and any host that
 * stops a tailer — the dev-dashboard as sessions come and go, `tools watch` on
 * an unlink — spends the rest of its life in the degraded state.
 *
 * This matters for what the benchmark can catch. In the healthy state an
 * append arrives in a few milliseconds through `fs.watch` and the 300 ms poll
 * is irrelevant, so changing the poll would not move the number at all. In the
 * degraded state the poll is the only delivery path and `appendLatencyMs`
 * tracks it exactly, which is the regression gate these scripts exist to be.
 * Arming it up front also makes the result independent of `--runs`: without
 * this, run 1 measures ~4 ms and runs 2+ measure ~300 ms, and the recorded
 * median would silently depend on how many runs were taken.
 */
export function armClosedWatcherState(dir: string): void {
    const path = join(dir, "arm-fs-watch.tmp");
    writeFileSync(path, "");
    watch(path, () => {}).close();
}

async function captureCommand(cmd: string[]): Promise<string> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    if (proc.exitCode !== 0) {
        return `unknown (${cmd[0]} exited ${proc.exitCode}: ${stderr.trim()})`;
    }

    return stdout.trim();
}

/** `git rev-parse --short HEAD` plus `uptime`, the two things a stale baseline needs. */
export async function baselineNotes(extra: string): Promise<string> {
    const [commit, uptime] = await Promise.all([
        captureCommand(["git", "rev-parse", "--short", "HEAD"]),
        captureCommand(["uptime"]),
    ]);
    return `${extra} | commit ${commit} | uptime ${uptime}`;
}

function formatCell(value: number): string {
    if (!Number.isFinite(value)) {
        return String(value);
    }

    if (Number.isInteger(value)) {
        return String(value);
    }

    return value.toFixed(2);
}

/** Per-run values next to the median that gets recorded, so an outlier is visible. */
function printRunTable(title: string, runs: BaselineMetrics[], merged: BaselineMetrics): void {
    renderCliHeader(title, `${runs.length} run(s), per-metric median recorded`);
    const table = createBoxTable(["METRIC", ...runs.map((_, index) => `RUN ${index + 1}`), "MEDIAN"]);

    for (const metric of Object.keys(merged)) {
        table.push([
            metric,
            ...runs.map((run) => formatCell(run[metric] as number)),
            formatCell(merged[metric] as number),
        ]);
    }

    out.println(table.toString());
}

export interface FinishInput {
    /** Baseline name, e.g. `fs-tools-watch`. */
    name: string;
    title: string;
    args: BenchArgs;
    runs: BaselineMetrics[];
    /** Metrics where a smaller number is an improvement. Everything else flips. */
    lowerIsBetter: string[];
    /**
     * Absolute tolerance per metric, in the metric's unit; a delta under it passes whatever the
     * percentage says. Sub-millisecond latencies and CPU shares under 1% cannot carry a 15% gate.
     */
    floor?: Record<string, number>;
    /** Free-form facts folded into the baseline notes and the JSON payload. */
    notes: string;
    /** Extra JSON-only context (tmp dirs, whether a counter intercepted, …). */
    context: Record<string, unknown>;
}

/**
 * Print the run table, then record or compare, then optionally emit JSON.
 * `--compare` sets `process.exitCode = 1` on a regression so a CI caller fails.
 */
export async function finishBench(input: FinishInput): Promise<void> {
    const metrics = medianMetrics(input.runs);
    printRunTable(input.title, input.runs, metrics);

    let comparison: unknown = null;

    if (input.args.baseline) {
        const notes = await baselineNotes(input.notes);
        const recorded = await recordBaseline({ name: input.name, metrics, notes });
        renderCliSection("Baseline recorded");
        out.println(`${input.name} @ ${recorded.commit} — ${recorded.capturedAt}`);
        out.println(notes);
    }

    if (input.args.compare) {
        const cmp = await compareToBaseline({
            name: input.name,
            metrics,
            tolerancePct: 15,
            lowerIsBetter: input.lowerIsBetter,
            ...(input.floor === undefined ? {} : { floor: input.floor }),
        });
        renderCliSection("Comparison");
        out.println(formatComparison(cmp));
        comparison = { ok: cmp.ok, deltas: cmp.deltas, missing: cmp.missing };

        if (!cmp.ok) {
            process.exitCode = 1;
        }
    }

    if (input.args.json) {
        out.result({
            name: input.name,
            runs: input.runs,
            metrics,
            lowerIsBetter: input.lowerIsBetter,
            notes: input.notes,
            comparison,
            ...input.context,
        });
    }
}

interface PendingMarker {
    resolve: (at: number) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const MARKER_BUFFER_MAX = 128 * 1024;
const MARKER_BUFFER_KEEP = 64 * 1024;

/**
 * Wait for a unique text marker to arrive in a stream of chunks.
 *
 * All three benchmarks measure "how long until the watcher shows me this", and
 * the only honest way to time that is to stamp the moment the bytes carrying a
 * unique marker arrive. Feed it child-process output, a JSONL line, or a raw
 * appended buffer; the interface is the same.
 *
 * The buffer is trimmed to the last 64 KiB so a long throughput run does not
 * turn `includes` into a quadratic scan and distort the number being measured.
 */
export class MarkerWaiter {
    private buffer = "";
    private readonly pending = new Map<string, PendingMarker>();

    feed(chunk: string): void {
        this.buffer += chunk;
        const at = performance.now();

        for (const [marker, entry] of [...this.pending]) {
            if (this.buffer.includes(marker)) {
                clearTimeout(entry.timer);
                this.pending.delete(marker);
                entry.resolve(at);
            }
        }

        if (this.buffer.length > MARKER_BUFFER_MAX) {
            this.buffer = this.buffer.slice(-MARKER_BUFFER_KEEP);
        }
    }

    /** Resolves with the `performance.now()` of the chunk that carried the marker. */
    wait(marker: string, timeoutMs: number): Promise<number> {
        if (this.buffer.includes(marker)) {
            return Promise.resolve(performance.now());
        }

        return new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(marker);
                reject(new Error(`marker "${marker}" did not arrive within ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(marker, { resolve, reject, timer });
        });
    }

    get text(): string {
        return this.buffer;
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
