#!/usr/bin/env bun
/**
 * What `tools metrics` costs: ingest through each door and queries at 100 k and 1 M events, in this process, on a
 * WAL file database in a scratch folder (never the real `~/.genesis-tools/metrics`).
 *
 *   bun scripts/benchmarks/metrics/ingest-query.ts --scratch <dir> [--runs 5] [--baseline [name] | --compare [name]]
 *
 * Arms, interleaved per run (the order turns each run):
 * - insert-1 / insert-100 / insert-1000: `MetricsStore.insert` of 20 000 events in batches of that size (events/s).
 * - spool-drain: 50 000 spool lines drained into an empty store (events/s).
 * - rpc-ingest: 20 000 events through a service's `ingest` in batches of 1000, over its socket (events/s).
 * - q100k-* / q1m-*: one query each at 100 k and 1 M events of one metric (ms): group by a declared dim, by two dims,
 *   by `time:hour`, a filter on a declared dim, a filter on an undeclared dim, p90 by a declared dim, and by
 *   `checkpoint` (5 checkpoints of the project: four in the first 160 s, so the 100 k metric's 259 s split into five
 *   groups, and one at day 15 of the 1 M metric's 30 days).
 * Each arm reports min / median / max of wall time and the process CPU time of the median run. The native-code gate
 * of the design: a median query above 250 ms at 1 M events, or a door's ingest below 50 000 events per second.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { compareToBaseline, formatComparison, recordBaseline } from "@app/benchmark/lib";
import { out } from "@genesiscz/utils/logger";
import { startMetricsService } from "@genesiscz/utils/metrics/service";
import { MetricsServiceClient } from "@genesiscz/utils/metrics/service-client";
import { appendSpoolLines, drainSpool, spoolLine } from "@genesiscz/utils/metrics/spool";
import { MetricsStore } from "@genesiscz/utils/metrics/store";
import type { MetricEvent, MetricQuery, StoredEvent } from "@genesiscz/utils/metrics/types";
import { readLiveServiceEntry } from "@genesiscz/utils/rpc/service-host";
import { formatTable } from "@genesiscz/utils/table";

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    const next = at >= 0 ? argv[at + 1] : undefined;
    return next && !next.startsWith("--") ? next : undefined;
};
const runs = Number(flagValue("--runs") ?? "5");
const scratch = flagValue("--scratch") ?? mkdtempSync(join(tmpdir(), "metrics-bench-"));
const baselineName = argv.includes("--baseline") ? (flagValue("--baseline") ?? "metrics-ingest-query") : undefined;
const compareName = argv.includes("--compare") ? (flagValue("--compare") ?? "metrics-ingest-query") : undefined;

if (!Number.isInteger(runs) || runs < 5) {
    out.printlnErr("--runs takes 5 or more: a timing needs N >= 5 (scripts/benchmarks/README.md)");
    process.exit(2);
}

mkdirSync(scratch, { recursive: true });

const AGENTS = Array.from({ length: 10 }, (_, i) => `agent${i}`);
const TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Agent", "Skill"];
const EVENTS = ["PostToolUse", "SessionStart", "SubagentStart", "Stop", "UserPromptSubmit", "PreToolUse"];
const T0 = Date.UTC(2026, 9, 1);

/** A deterministic event: about the shape of a hook injection, spread over 30 days. */
function eventAt(i: number, metric: string): StoredEvent {
    return {
        project: "bench",
        metric,
        at: T0 + Math.floor((i * 2_592_000_000) / 1_000_000),
        value: (i * 7919) % 10_000,
        dims: {
            agent: AGENTS[i % AGENTS.length] ?? "agent0",
            event: EVENTS[(i >> 3) % EVENTS.length] ?? "Stop",
            tool: TOOLS[(i >> 1) % TOOLS.length] ?? "Bash",
            session: `s${i % 200}`,
            dropped: i % 17 === 0,
        },
        context: `entry ${i}`,
    };
}

let dbCount = 0;
const freshStore = () => MetricsStore.open({ path: join(scratch, `db-${process.pid}-${++dbCount}.db`) });

function cpuMs(): number {
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1000;
}

interface Sample {
    wallMs: number;
    cpuMs: number;
    /** Events per second for an ingest arm. */
    rate?: number;
}

async function timed(work: () => Promise<number> | number): Promise<Sample> {
    const cpu = cpuMs();
    const started = performance.now();
    const events = await work();
    const wallMs = performance.now() - started;
    return { wallMs, cpuMs: cpuMs() - cpu, ...(events > 0 ? { rate: (events * 1000) / wallMs } : {}) };
}

const INSERT_EVENTS = 20_000;

const insertEvents = Array.from({ length: INSERT_EVENTS }, (_, i) => eventAt(i, "insert"));

function insertArm(batch: number): () => number {
    return () => {
        const store = freshStore();

        for (let i = 0; i < insertEvents.length; i += batch) {
            store.insert(insertEvents.slice(i, i + batch));
        }

        store.close();
        return insertEvents.length;
    };
}

const DRAIN_LINES = 50_000;

function drainArm(): { prepare: () => string; run: (dir: string) => number } {
    return {
        prepare: () => {
            const dir = join(scratch, `spool-${++dbCount}`);
            const lines: string[] = [];

            for (let i = 0; i < DRAIN_LINES; i++) {
                const event: MetricEvent = eventAt(i, "drained");
                lines.push(spoolLine(event));
            }

            appendSpoolLines({ dir, writer: "bench", lines });
            return dir;
        },
        run: (dir) => {
            const store = freshStore();
            const result = drainSpool(store, { dir });
            store.close();
            return result.events;
        },
    };
}

const RPC_EVENTS = 20_000;
const serviceRoot = join(scratch, `svc-${process.pid}`);
const service = await startMetricsService({
    dir: join(serviceRoot, "s"),
    dbPath: join(serviceRoot, "metrics.db"),
    spoolDir: join(serviceRoot, "spool"),
    idleMs: 0,
    watch: false,
    drainEveryMs: 0,
    code: "benchmark000",
});

if (service.status !== "started") {
    throw new Error("the benchmark's metrics service did not start");
}

const entry = readLiveServiceEntry(join(serviceRoot, "s"));

if (!entry) {
    throw new Error("the benchmark's metrics service wrote no service.json");
}

const client = await MetricsServiceClient.connect(entry);
const rpcEvents: MetricEvent[] = Array.from({ length: RPC_EVENTS }, (_, i) => eventAt(i, "rpc"));

async function rpcArm(): Promise<number> {
    let accepted = 0;

    for (let i = 0; i < rpcEvents.length; i += 1000) {
        accepted += (await client.call("ingest", { events: rpcEvents.slice(i, i + 1000) })).accepted;
    }

    return accepted;
}

out.printlnErr(`building the query store in ${scratch} (100 k and 1 M events)`);
const queryStore = freshStore();

for (const [metric, count] of [
    ["q100k", 100_000],
    ["q1m", 1_000_000],
] as const) {
    for (let i = 0; i < count; i += 10_000) {
        queryStore.insert(Array.from({ length: Math.min(10_000, count - i) }, (_, j) => eventAt(i + j, metric)));
    }

    queryStore.define({ project: "bench", metric, unit: "chars", dims: ["agent", "event"] });
}

for (const [index, at] of [40_000, 80_000, 120_000, 160_000, 15 * 86_400_000].entries()) {
    queryStore.addCheckpoint({ project: "bench", name: `cp${index + 1}`, at: T0 + at });
}

const queries: Record<string, Omit<MetricQuery, "project" | "metric">> = {
    "group-declared": { groupBy: ["agent"] },
    "group-two": { groupBy: ["agent", "tool"] },
    "group-hour": { groupBy: ["time:hour"], sort: { by: "time:hour", descending: false }, limit: 1000 },
    "filter-declared": { where: [{ dim: "event", op: "=", value: "Stop" }], groupBy: ["agent"] },
    "filter-undeclared": { where: [{ dim: "tool", op: "=", value: "Bash" }], groupBy: ["agent"] },
    p90: { groupBy: ["agent"], aggregates: ["count", "p90"] },
    "group-checkpoint": { groupBy: ["checkpoint"] },
};

const drain = drainArm();
const arms: Array<{ name: string; prepare?: () => string; run: (prepared: string) => Promise<number> | number }> = [
    { name: "insert-1", run: insertArm(1) },
    { name: "insert-100", run: insertArm(100) },
    { name: "insert-1000", run: insertArm(1000) },
    { name: "spool-drain", prepare: drain.prepare, run: drain.run },
    { name: "rpc-ingest", run: () => rpcArm() },
    ...(["q100k", "q1m"] as const).flatMap((metric) =>
        Object.entries(queries).map(([name, query]) => ({
            name: `${metric}-${name}`,
            run: () => {
                queryStore.query({ project: "bench", metric, ...query });
                return 0;
            },
        }))
    ),
];

const samples = new Map<string, Sample[]>();

for (let run = 0; run < runs; run++) {
    const order = run % 2 === 0 ? arms : [...arms].reverse();

    for (const arm of order) {
        const prepared = arm.prepare?.() ?? "";
        const sample = await timed(() => arm.run(prepared));
        samples.set(arm.name, [...(samples.get(arm.name) ?? []), sample]);
    }
}

client.close();
service.service.stop("benchmark end");
queryStore.close();

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const median = (values: number[]) => {
    const list = sorted(values);
    const mid = Math.floor(list.length / 2);
    return list.length % 2 ? (list[mid] ?? 0) : ((list[mid - 1] ?? 0) + (list[mid] ?? 0)) / 2;
};

const metrics: Record<string, number> = {};
const rows: string[][] = [];

for (const [name, list] of samples) {
    const walls = list.map((sample) => sample.wallMs);
    const rates = list.flatMap((sample) => (sample.rate ? [sample.rate] : []));
    const cpu = median(list.map((sample) => sample.cpuMs));
    metrics[`${name}.wallMs`] = median(walls);
    metrics[`${name}.cpuMs`] = cpu;

    if (rates.length) {
        metrics[`${name}.eventsPerSec`] = median(rates);
    }

    rows.push([
        name,
        sorted(walls)[0]?.toFixed(1) ?? "",
        median(walls).toFixed(1),
        sorted(walls).at(-1)?.toFixed(1) ?? "",
        cpu.toFixed(1),
        rates.length ? Math.round(median(rates)).toLocaleString("en-US") : "",
    ]);
}

const slowQueries = Object.keys(queries).filter((name) => (metrics[`q1m-${name}.wallMs`] ?? 0) > 250);
const slowDoors = ["insert-1000", "spool-drain", "rpc-ingest"].filter(
    (name) => (metrics[`${name}.eventsPerSec`] ?? 0) < 50_000
);
const load = loadavg().map((value) => value.toFixed(2));

out.println(`bun ${Bun.version}, ${runs} runs, load average ${load.join(" ")}, scratch ${scratch}`);
out.println(formatTable(rows, ["arm", "min ms", "median ms", "max ms", "cpu ms (median)", "events/s (median)"]));
out.println(
    `native-code gate: ${slowQueries.length || slowDoors.length ? `TRIGGERED (slow queries: ${slowQueries.join(", ") || "none"}; slow doors: ${slowDoors.join(", ") || "none"})` : "not triggered"}`
);

if (baselineName) {
    await recordBaseline({ name: baselineName, metrics, notes: `runs ${runs}` });
}

if (compareName) {
    const comparison = await compareToBaseline({
        name: compareName,
        metrics,
        tolerancePct: 25,
        lowerIsBetter: Object.keys(metrics).filter((key) => !key.endsWith(".eventsPerSec")),
    });
    out.println(formatComparison(comparison));

    if (!comparison.ok) {
        process.exitCode = 1;
    }
}

out.result({ runs, loadAvg: loadavg(), metrics, gate: { slowQueries, slowDoors } });
process.exit(process.exitCode ?? 0);
