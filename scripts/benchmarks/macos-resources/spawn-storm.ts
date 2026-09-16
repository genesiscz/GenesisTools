/**
 * Black-box spawn-storm probe for the `tools macos-resources` TUI.
 *
 * It measures the LIVE process rather than importing it. Before the overhaul the
 * module could not be imported at all: it read argv and called `render()` at
 * import time, so there was nothing to call headlessly. Keeping the probe
 * black-box after the overhaul is what makes the before and after numbers
 * comparable.
 *
 * Three metrics come out of one run:
 *
 * - `cpuPercent`      CPU burned by the TUI process over the window. 100 is one
 *                     fully busy core. Transient `ps` / `lsof` children are NOT
 *                     in this number; they die before a sample can see them.
 * - `rssMb`           resident set size at the end of the window.
 * - `spawnsPerMinute` distinct `sh` / `ps` / `lsof` / `wc` descendants seen by a
 *                     100 ms sampler, scaled to a minute. This is a FLOOR, and a
 *                     loose one: those children live single-digit milliseconds,
 *                     so a 100 ms sampler misses most of them. Use
 *                     `count-spawns.ts` for the exact per-cycle count.
 *
 * Ink calls `useInput`, which needs raw mode, and the TUI dies with "Raw mode is
 * not supported" when stdin is /dev/null. The child therefore runs under
 * `script -q /dev/null`, which hands it a pty.
 *
 * ```bash
 * bun scripts/benchmarks/macos-resources/spawn-storm.ts --seconds 20 --runs 3
 * bun scripts/benchmarks/macos-resources/spawn-storm.ts --baseline
 * bun scripts/benchmarks/macos-resources/spawn-storm.ts --compare
 * ```
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { compareToBaseline, formatComparison, recordBaseline, sampleProcess } from "@app/benchmark/lib";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";

const { log } = logger.scoped("bench-macos-resources");

const BASELINE_NAME = "macos-resources-spawn-storm";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const DEFAULT_ENTRY = "src/macos-resources/index.tsx";
const MAX_TREE_DEPTH = 24;
const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 3_000;
const BYTES_PER_MB = 1024 * 1024;

/**
 * Children this tool is known to fork. `sh` is here because `node:child_process.exec`
 * runs everything through `/bin/sh -c`, so the shell is a spawn in its own right.
 */
const SPAWN_BINARIES = new Set(["sh", "bash", "zsh", "ps", "lsof", "wc", "osascript", "say"]);

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/;

interface PsEntry {
    ppid: number;
    command: string;
}

interface RunResult {
    arm: string;
    sampledPid: number;
    cpuPercent: number;
    rssMb: number;
    spawnsPerMinute: number;
    distinctSpawns: number;
    treeSamples: number;
    /**
     * How many processes existed on the machine during the run.
     *
     * The single most important piece of provenance here. The table renders one
     * row per process, so this drives both CPU and memory; on a busy machine it
     * swings by 4x between runs minutes apart, which is more than any code change
     * moves them. Two numbers taken at different counts are not comparable.
     */
    processCount: number;
    byBinary: Record<string, number>;
    exitedOnSigint: boolean;
}

function parsePsTree(stdout: string): Map<number, PsEntry> {
    const table = new Map<number, PsEntry>();

    for (const raw of stdout.split("\n")) {
        const match = raw.match(PS_LINE);

        if (match === null) {
            continue;
        }

        table.set(Number.parseInt(match[1], 10), {
            ppid: Number.parseInt(match[2], 10),
            command: match[3].trim(),
        });
    }

    return table;
}

/** The basename of argv[0] when it is one of the forks this tool makes, else null. */
function spawnBinary(command: string): string | null {
    const argv0 = command.trim().split(/\s+/)[0] ?? "";
    const base = argv0.split("/").pop() ?? "";

    return SPAWN_BINARIES.has(base) ? base : null;
}

function isDescendantOf(pid: number, root: number, table: Map<number, PsEntry>): boolean {
    let current = pid;

    for (let depth = 0; depth < MAX_TREE_DEPTH; depth++) {
        const entry = table.get(current);

        if (entry === undefined) {
            return false;
        }

        if (entry.ppid === root) {
            return true;
        }

        if (entry.ppid <= 1) {
            return false;
        }

        current = entry.ppid;
    }

    return false;
}

async function readPsTree(): Promise<Map<number, PsEntry>> {
    const proc = Bun.spawn(["ps", "-Ao", "pid=,ppid=,command="], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    if (proc.exitCode !== 0) {
        throw new Error(`ps -Ao failed with ${proc.exitCode}: ${stderr.trim()}`);
    }

    return parsePsTree(stdout);
}

/**
 * The pid actually running the TUI.
 *
 * The harness root is never it. `script -q /dev/null bun run <entry>` carries the
 * entry path in its OWN argv, so a match on the command string alone picks the
 * `script` wrapper: 1.2 MB of RSS and no CPU, which reads as a perfectly idle
 * tool. Only a strict descendant counts.
 */
async function resolveTuiPid(rootPid: number, entry: string): Promise<number> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const table = await readPsTree();
        const candidates: number[] = [];

        for (const [pid, psEntry] of table) {
            if (!psEntry.command.includes(entry) || pid === rootPid) {
                continue;
            }

            if (isDescendantOf(pid, rootPid, table)) {
                candidates.push(pid);
            }
        }

        if (candidates.length > 0) {
            // The deepest match is the one doing the work: `bun run` may re-exec and
            // the inner process keeps the same argv.
            return Math.max(...candidates);
        }

        await Bun.sleep(200);
    }

    throw new Error(`No descendant of pid ${rootPid} ran ${entry} within ${STARTUP_TIMEOUT_MS} ms`);
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 1) {
        return sorted[mid];
    }

    return (sorted[mid - 1] + sorted[mid]) / 2;
}

async function isAlive(pid: number): Promise<boolean> {
    const table = await readPsTree();

    return table.has(pid);
}

async function waitForExit(pid: number, graceMs: number): Promise<boolean> {
    const deadline = Date.now() + graceMs;

    while (Date.now() < deadline) {
        if (!(await isAlive(pid))) {
            return true;
        }

        await Bun.sleep(100);
    }

    return false;
}

/**
 * Stop the run and prove it stopped.
 *
 * SIGINT goes to the `script` wrapper, which does not forward it: killing the
 * wrapper alone leaves the TUI reparented to launchd, still spawning. So the
 * wrapper's death is followed by a signal to the TUI itself, and the pid is
 * re-checked after each escalation. An unverified kill here leaks a spawn storm
 * that then poisons the next run's numbers.
 */
async function stopChild(child: Bun.Subprocess, tuiPid: number): Promise<boolean> {
    child.kill("SIGINT");

    if (await waitForExit(tuiPid, SHUTDOWN_GRACE_MS)) {
        return true;
    }

    log.warn({ tuiPid }, "SIGINT on the pty wrapper left the TUI alive; signalling the TUI directly");

    try {
        // pid-verified: tuiPid is the bun run we spawned this arm, re-checked after SIGINT
        process.kill(tuiPid, "SIGTERM");
    } catch (err) {
        log.debug({ err, tuiPid }, "SIGTERM raced the process exiting");
    }

    if (await waitForExit(tuiPid, SHUTDOWN_GRACE_MS)) {
        return false;
    }

    log.warn({ tuiPid }, "SIGTERM did not stop the TUI either; escalating to SIGKILL");
    child.kill("SIGKILL");

    try {
        // pid-verified: same tuiPid as above, still the arm this run started
        process.kill(tuiPid, "SIGKILL");
    } catch (err) {
        log.debug({ err, tuiPid }, "SIGKILL raced the process exiting");
    }

    if (!(await waitForExit(tuiPid, SHUTDOWN_GRACE_MS))) {
        throw new Error(`pid ${tuiPid} survived SIGKILL; refusing to start another run on top of it`);
    }

    return false;
}

/**
 * Every live process running `bun run <entry>` other than the pty wrapper and `except`.
 *
 * Exists because one arm outlived a run on 2026-09-16: `stopChild` verified the pid it had
 * resolved, but a second `bun run` of the same entry, reparented to launchd, kept spawning
 * `lsof` per process for minutes and pushed the load average to 256 while other benchmarks ran.
 */
function survivorsOf(entry: string, except: readonly number[] = []): number[] {
    const table = Bun.spawnSync(["ps", "-Ao", "pid=,command="], { stdout: "pipe", stderr: "pipe" });
    const needle = `bun run ${entry}`;
    const survivors: number[] = [];

    for (const line of table.stdout.toString().split("\n")) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);

        if (!match || !match[2]!.includes(needle) || match[2]!.includes("script -q")) {
            continue;
        }

        const pid = Number(match[1]);

        if (!except.includes(pid)) {
            survivors.push(pid);
        }
    }

    return survivors;
}

/** Refuse to measure on top of a leaked arm: its spawn storm would land in this run's numbers. */
function refuseIfLeaked(entry: string): void {
    const leaked = survivorsOf(entry);

    if (leaked.length > 0) {
        throw new Error(
            `a previous run of ${entry} is still alive (pid ${leaked.join(", ")}); kill it before measuring again`
        );
    }
}

/** After the tracked pid is gone, kill any other process of the same entry the pty wrapper left behind. */
async function sweepSurvivors(entry: string): Promise<void> {
    for (const pid of survivorsOf(entry)) {
        log.warn({ pid, entry }, "a second process of the entry outlived the run; killing it");

        try {
            // pid-verified: survivorsOf matched a live `bun run ${entry}` ps row this sweep
            process.kill(pid, "SIGKILL");
        } catch (err) {
            log.debug({ err, pid }, "survivor exited before the kill landed");
        }
    }

    const left = survivorsOf(entry);

    if (left.length > 0) {
        throw new Error(`pid ${left.join(", ")} of ${entry} survived SIGKILL; refusing to continue`);
    }
}

async function runOnce(opts: { seconds: number; sampleMs: number; entry: string; arm: string }): Promise<RunResult> {
    refuseIfLeaked(opts.entry);
    const child = Bun.spawn(["script", "-q", "/dev/null", "bun", "run", opts.entry], {
        cwd: REPO_ROOT,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
    });

    const tuiPid = await resolveTuiPid(child.pid, opts.entry);
    log.debug({ harnessPid: child.pid, tuiPid, arm: opts.arm }, "TUI started under a pty");

    const seenSpawns = new Map<number, string>();
    let treeSamples = 0;
    let processCount = 0;
    let sampling = true;

    const sampler = (async () => {
        while (sampling) {
            try {
                const table = await readPsTree();
                treeSamples++;
                processCount = Math.max(processCount, table.size);

                for (const [pid, entry] of table) {
                    const binary = spawnBinary(entry.command);

                    if (binary === null || seenSpawns.has(pid)) {
                        continue;
                    }

                    if (isDescendantOf(pid, tuiPid, table)) {
                        seenSpawns.set(pid, binary);
                    }
                }
            } catch (err) {
                log.warn({ err }, "a process-tree sample failed; continuing");
            }

            await Bun.sleep(opts.sampleMs);
        }
    })();

    const sample = await sampleProcess(tuiPid, { windowMs: opts.seconds * 1000 });
    sampling = false;
    await sampler;

    const exitedOnSigint = await stopChild(child, tuiPid);
    await sweepSurvivors(opts.entry);
    const byBinary: Record<string, number> = {};

    for (const binary of seenSpawns.values()) {
        byBinary[binary] = (byBinary[binary] ?? 0) + 1;
    }

    return {
        arm: opts.arm,
        sampledPid: tuiPid,
        cpuPercent: sample.cpuPercent,
        rssMb: sample.rssBytes / BYTES_PER_MB,
        spawnsPerMinute: (seenSpawns.size / sample.windowMs) * 60_000,
        distinctSpawns: seenSpawns.size,
        treeSamples,
        processCount,
        byBinary,
        exitedOnSigint,
    };
}

const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        seconds: { type: "string", default: "20" },
        runs: { type: "string", default: "3" },
        "sample-ms": { type: "string", default: "100" },
        entry: { type: "string", default: DEFAULT_ENTRY },
        vs: { type: "string" },
        name: { type: "string", default: BASELINE_NAME },
        notes: { type: "string" },
        baseline: { type: "boolean", default: false },
        compare: { type: "boolean", default: false },
    },
});

const seconds = Number.parseInt(values.seconds, 10);
const runs = Number.parseInt(values.runs, 10);
const sampleMs = Number.parseInt(values["sample-ms"], 10);

if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(runs) || runs <= 0) {
    out.printlnErr("--seconds and --runs must be positive integers.");
    process.exit(1);
}

/**
 * The arms, in the order they run. With `--vs` they alternate A, B, A, B rather
 * than running A to completion first: the row count on this machine swings by
 * several times within minutes, and the table renders one row per process, so
 * running the arms back to back turns a load change into "the fix".
 */
const arms =
    values.vs === undefined
        ? [{ arm: "this", entry: values.entry }]
        : [
              { arm: "this", entry: values.entry },
              { arm: "vs", entry: values.vs },
          ];

const results: RunResult[] = [];

for (let i = 0; i < runs; i++) {
    for (const arm of arms) {
        out.printlnErr(`run ${i + 1}/${runs} arm ${arm.arm} (${arm.entry}): ${seconds}s window`);
        results.push(await runOnce({ seconds, sampleMs, entry: arm.entry, arm: arm.arm }));
    }
}

function summarise(arm: string) {
    const runsForArm = results.filter((r) => r.arm === arm);
    const cpu = runsForArm.map((r) => r.cpuPercent);
    const rss = runsForArm.map((r) => r.rssMb);
    const spawns = runsForArm.map((r) => r.spawnsPerMinute);
    const processCounts = runsForArm.map((r) => r.processCount);

    return {
        cpu,
        rss,
        spawns,
        processCounts,
        metrics: {
            cpuPercent: median(cpu),
            rssMb: median(rss),
            spawnsPerMinute: median(spawns),
        },
    };
}

const primary = summarise("this");
const metrics = primary.metrics;

function metricRows(summary: ReturnType<typeof summarise>) {
    return [
        [
            "cpuPercent",
            Math.min(...summary.cpu).toFixed(2),
            summary.metrics.cpuPercent.toFixed(2),
            Math.max(...summary.cpu).toFixed(2),
        ],
        [
            "rssMb",
            Math.min(...summary.rss).toFixed(1),
            summary.metrics.rssMb.toFixed(1),
            Math.max(...summary.rss).toFixed(1),
        ],
        [
            "spawnsPerMinute",
            Math.min(...summary.spawns).toFixed(0),
            summary.metrics.spawnsPerMinute.toFixed(0),
            Math.max(...summary.spawns).toFixed(0),
        ],
        [
            "processCount",
            String(Math.min(...summary.processCounts)),
            String(median(summary.processCounts)),
            String(Math.max(...summary.processCounts)),
        ],
    ];
}

for (const arm of arms) {
    const summary = summarise(arm.arm);
    out.println(`\n${arm.arm} — ${arm.entry}`);
    out.println(formatTable(metricRows(summary), ["METRIC", "MIN", "MEDIAN", "MAX"], { alignRight: [1, 2, 3] }));
}

out.println("");
out.println(`runs ${runs} per arm · window ${seconds}s · tree samples ${results.map((r) => r.treeSamples).join(", ")}`);
out.println(`spawn mix per run: ${results.map((r) => `${r.arm}=${SafeJSON.stringify(r.byBinary)}`).join("  ")}`);
out.println(`SIGINT stopped the TUI: ${results.every((r) => r.exitedOnSigint) ? "yes" : "NO — escalated"}`);
out.println("spawnsPerMinute is a sampled FLOOR; the forks are milliseconds long and most are never seen.");
out.println("processCount is provenance: cpu and rss both scale with it, so compare arms at similar counts only.");

if (values.baseline) {
    const notes =
        values.notes ??
        `${runs} runs of ${seconds}s under a pty, median kept; spawnsPerMinute sampled at ${sampleMs}ms and is a floor`;
    await recordBaseline({ name: values.name, metrics, notes });
    out.println(`\nRecorded baseline ${values.name}.`);
}

if (values.compare) {
    const cmp = await compareToBaseline({ name: values.name, metrics, tolerancePct: 10 });
    out.println(`\n${formatComparison(cmp)}`);
    process.exitCode = cmp.ok ? 0 : 1;
}

out.result({ metrics, runs: results, seconds, sampleMs });
