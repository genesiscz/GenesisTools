#!/usr/bin/env bun
/**
 * Idle cost of the dev-dashboard UI server, per serve mode.
 *
 * The installed dev-dashboard runs `src/dev-dashboard/index.ts __ui-server` in
 * PREVIEW mode, which parks a rolldown watch build for the whole life of the
 * process whether or not a file ever changes. This measures what that costs
 * while nothing is happening, so a build-once static-serve mode has a number to
 * beat.
 *
 * Modes:
 *  - `preview` — the installed default (watch build, vite preview, front proxy).
 *  - `dev` — `--dev`, a real vite dev server behind the same front proxy. The
 *    vite server is a SEPARATE child process, which is why the tree metrics
 *    exist: the parent alone is only the proxy and reads almost free.
 *  - `static` — `--static`, one build into the install-owned directory under the
 *    run's throwaway home, then vite preview + front proxy with no watcher of any
 *    kind. This is what `ui install` registers now.
 *
 * Several modes may be given at once (`--mode preview,dev`), and `--repeat`
 * runs them round-robin rather than all of one then all of the other, so a load
 * change during the run cannot become "the fix". Each metric is reported as
 * min/median/max and the MEDIAN is what a baseline records. One sample is not
 * enough here: two preview runs four minutes apart differed by 2x on RSS.
 *
 * `--window` shortens the idle window so the whole path (spawn, readiness,
 * sampling, kill) can be smoked in seconds. `--baseline` refuses a window under
 * the 60 s default, because a short window measures boot noise, not idle.
 *
 * Safety, both of which matter more than the numbers:
 *  - `__ui-server` has NO `--port` flag. It reads the public port from the
 *    dev-dashboard config and calls `stopUiServerOnPort` on it, which would kill
 *    the live dashboard on 3042. The child therefore gets its own
 *    `GENESIS_TOOLS_HOME` holding a throwaway config pinned to a free port.
 *  - The preview arm rebuilds `src/dev-dashboard/ui/dist` with `emptyOutDir`,
 *    and the live dashboard serves static files out of that same directory. The
 *    directory is copied into the run's tmp dir first and copied back when the
 *    child never becomes ready, so a failed build cannot leave the live
 *    dashboard with an empty document root.
 */
import { mkdirSync, mkdtempSync, openSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    compareToBaseline,
    formatComparison,
    type ProcessSample,
    recordBaseline,
    sampleProcess,
} from "@app/benchmark/lib";
import { runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { buildDashboardUiServerCmd } from "@genesiscz/utils/DashboardApp";
import { waitForUrlReady } from "@genesiscz/utils/DashboardApp/readiness";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { findFreePort } from "@genesiscz/utils/net/free-port";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";
import { createBoxTable, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import { terminalLocaleEnvRecord } from "@genesiscz/utils/terminal/locale";
import type { Subprocess } from "bun";
import { Command } from "commander";

const { log } = logger.scoped("bench-dashboards-idle");

const MODES = ["preview", "dev", "static"] as const;
type Mode = (typeof MODES)[number];

/** The first preview build compiles the whole UI, so readiness is generous. */
const READY_TIMEOUT_MS = 90_000;
/** Let the boot settle before the window opens, or the build lands inside it. */
const SETTLE_MS = 10_000;
/**
 * A real idle reading needs the full minute. `--window` shortens it only so a
 * smoke run can prove spawn, readiness, sampling and kill in seconds; a number
 * measured over a short window is not a baseline.
 */
const DEFAULT_WINDOW_MS = 60_000;
/** SIGTERM grace before SIGKILL, matching what the dashboard lifecycle allows. */
const KILL_GRACE_MS = 10_000;

const SERVER_SCRIPT = resolve(PROJECT_ROOT, "src", "dev-dashboard", "index.ts");
const DIST_DIR = resolve(PROJECT_ROOT, "src", "dev-dashboard", "ui", "dist");

interface CommandResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

async function runCommand(args: string[]): Promise<CommandResult> {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return { code: proc.exitCode, stdout, stderr };
}

/** Direct children of a pid. `pgrep` exits 1 with no output when there are none. */
async function listChildren(pid: number): Promise<number[]> {
    const result = await runCommand(["pgrep", "-P", String(pid)]);

    if (result.stderr.trim().length > 0) {
        log.warn({ pid, stderr: result.stderr.trim() }, "pgrep wrote to stderr while listing children");
    }

    return result.stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
}

/** Every descendant of a pid, breadth-first. Used for killing and for tree totals. */
async function listDescendants(pid: number): Promise<number[]> {
    const found: number[] = [];
    let frontier = [pid];

    while (frontier.length > 0) {
        const next: number[] = [];

        for (const parent of frontier) {
            const children = await listChildren(parent);

            for (const child of children) {
                if (!found.includes(child)) {
                    found.push(child);
                    next.push(child);
                }
            }
        }

        frontier = next;
    }

    return found;
}

/**
 * Who is listening on a port, as raw `lsof` output. stderr is returned rather
 * than discarded: an lsof that failed prints nothing on stdout, which is
 * indistinguishable from a free port once stderr is gone.
 */
async function portHolders(port: number): Promise<CommandResult> {
    return runCommand(["lsof", "-nP", `-iTCP:${port}`]);
}

function signal(pid: number, name: NodeJS.Signals): void {
    try {
        process.kill(pid, name);
    } catch (err) {
        log.debug({ err, pid, signal: name }, "signal failed; the process is already gone");
    }
}

interface StopResult {
    exitCode: number | null;
    forcedKill: boolean;
    survivors: number[];
    holders: CommandResult;
}

/**
 * SIGTERM the child and every descendant, wait, then SIGKILL what is left.
 *
 * The descendants are signalled individually rather than through the process
 * group: `Bun.spawn` does not start a new session, so the child shares THIS
 * process's group and `kill(-pid)` would take the benchmark down with it.
 */
async function stopChild(child: Subprocess, port: number): Promise<StopResult> {
    const pid = child.pid;
    const descendants = await listDescendants(pid);
    signal(pid, "SIGTERM");

    for (const descendant of descendants) {
        signal(descendant, "SIGTERM");
    }

    const timedOut = Symbol("timeout");
    const outcome = await Promise.race([child.exited, Bun.sleep(KILL_GRACE_MS).then(() => timedOut)]);
    const forcedKill = outcome === timedOut;

    if (forcedKill) {
        log.warn({ pid, graceMs: KILL_GRACE_MS }, "child outlived the SIGTERM grace; escalating to SIGKILL");
        signal(pid, "SIGKILL");
        await child.exited;
    }

    for (const descendant of descendants) {
        signal(descendant, "SIGKILL");
    }

    // The port takes a moment to come back after the listener dies.
    await Bun.sleep(1_000);
    const survivors: number[] = [];

    for (const descendant of descendants) {
        const alive = await runCommand(["ps", "-o", "pid=", "-p", String(descendant)]);

        if (alive.stdout.trim().length > 0) {
            survivors.push(descendant);
        }
    }

    return { exitCode: child.exitCode, forcedKill, survivors, holders: await portHolders(port) };
}

interface RunDirs {
    root: string;
    home: string;
    stdoutPath: string;
    stderrPath: string;
    distBackup: string;
}

function prepareRunDirs(mode: Mode): RunDirs {
    const root = mkdtempSync(join(tmpdir(), "dashboards-idle-cost-"));
    const home = join(root, "home");
    mkdirSync(join(home, ".genesis-tools", "dev-dashboard"), { recursive: true });
    return {
        root,
        home,
        stdoutPath: join(root, `${mode}-stdout.log`),
        stderrPath: join(root, `${mode}-stderr.log`),
        distBackup: join(root, "dist-before"),
    };
}

/**
 * The throwaway dev-dashboard config the child reads through its sandboxed
 * `GENESIS_TOOLS_HOME`. Basic Auth is off so the readiness probe measures the
 * app rather than a 401, and the port is the free one this run picked.
 */
async function writeSandboxConfig(home: string, port: number): Promise<string> {
    const path = join(home, ".genesis-tools", "dev-dashboard", "config.json");
    const config = { port, allowedHosts: [], ttydSessions: [], auth: { enabled: false } };
    await Bun.write(path, `${SafeJSON.stringify(config, null, 4)}\n`);
    return path;
}

function childEnv(home: string, port: number): Record<string, string | undefined> {
    return {
        ...process.env,
        ...terminalLocaleEnvRecord(),
        // What `spawnEnv()` in src/utils/DashboardApp/lifecycle.ts injects for a
        // type:"ui" app, so the child behaves like the launchd-started one.
        FORCE_COLOR: "1",
        BROWSER: "none",
        DASHBOARD_BIND_HOST: "127.0.0.1",
        DASHBOARD_OPEN_BROWSER: undefined,
        GENESIS_TOOLS_HOME: home,
        DEV_DASHBOARD_PUBLIC_PORT: String(port),
    };
}

async function tail(path: string, lines: number): Promise<string> {
    const file = Bun.file(path);

    if (!(await file.exists())) {
        return "";
    }

    return (await file.text()).trimEnd().split("\n").slice(-lines).join("\n");
}

interface Measurement {
    mode: Mode;
    round: number;
    port: number;
    pid: number;
    startupMs: number;
    main: ProcessSample;
    childProcesses: number;
    treeCpuPercent: number;
    treeRssBytes: number;
    treePids: number[];
    loadAvgBefore: number;
    stop: StopResult;
    logDir: string;
}

async function measure(mode: Mode, round: number, windowMs: number): Promise<Measurement> {
    const port = await findFreePort();
    const dirs = prepareRunDirs(mode);
    const configPath = await writeSandboxConfig(dirs.home, port);
    const cmd = buildDashboardUiServerCmd({ serverScript: SERVER_SCRIPT, mode });
    const loadAvgBefore = Number((loadavg()[0] ?? 0).toFixed(2));

    if (mode === "preview") {
        const copied = await runCommand(["cp", "-R", DIST_DIR, dirs.distBackup]);

        if (copied.code !== 0) {
            log.warn({ stderr: copied.stderr.trim() }, "could not back up the shared dist before the watch build");
        }
    }

    out.log.step(`${mode} #${round}: port ${port}, load ${loadAvgBefore}, home ${dirs.home}`);
    log.info({ mode, round, port, cmd, configPath }, "spawning the dev-dashboard ui server");

    const stdoutFd = openSync(dirs.stdoutPath, "w");
    const stderrFd = openSync(dirs.stderrPath, "w");
    const startedAt = performance.now();
    const child = Bun.spawn(cmd, {
        cwd: PROJECT_ROOT,
        env: childEnv(dirs.home, port),
        stdin: "ignore",
        stdout: stdoutFd,
        stderr: stderrFd,
    });

    const ready = await waitForUrlReady(`http://127.0.0.1:${port}/`, READY_TIMEOUT_MS);
    const startupMs = Math.round(performance.now() - startedAt);

    if (!ready.ready) {
        const stop = await stopChild(child, port);

        if (mode === "preview") {
            out.log.warn("restoring the shared dist from the backup taken before the build");
            await runCommand(["cp", "-R", `${dirs.distBackup}/.`, DIST_DIR]);
        }

        out.error(`${mode} #${round}: never became ready — ${ready.detail}`);
        out.println(await tail(dirs.stderrPath, 40));
        log.error({ mode, round, detail: ready.detail, stop, logDir: dirs.root }, "readiness failed");
        throw new Error(`${mode} did not become ready in ${READY_TIMEOUT_MS}ms; logs in ${dirs.root}`);
    }

    out.log.step(`${mode} #${round}: ready in ${startupMs}ms — settling ${SETTLE_MS / 1000}s`);
    await Bun.sleep(SETTLE_MS);

    // Descendants are enumerated BEFORE the window so every process in the tree
    // is measured over the same interval. One spawned mid-window is missed.
    const descendants = await listDescendants(child.pid);
    const children = await listChildren(child.pid);
    out.log.step(`${mode} #${round}: sampling ${windowMs / 1000}s over ${descendants.length + 1} process(es)`);
    const samples = await Promise.all([child.pid, ...descendants].map((pid) => sampleProcess(pid, { windowMs })));
    const main = samples[0];

    if (!main?.alive) {
        const stop = await stopChild(child, port);
        log.error({ mode, round, stop, logDir: dirs.root }, "the main pid died during the idle window");
        throw new Error(`${mode}: the server died during the idle window; logs in ${dirs.root}`);
    }

    const alive = samples.filter((sample) => sample.alive);
    const stop = await stopChild(child, port);

    return {
        mode,
        round,
        port,
        pid: child.pid,
        startupMs,
        main,
        childProcesses: children.length,
        treeCpuPercent: alive.reduce((total, sample) => total + sample.cpuPercent, 0),
        treeRssBytes: alive.reduce((total, sample) => total + sample.rssBytes, 0),
        treePids: [child.pid, ...descendants],
        loadAvgBefore,
        stop,
        logDir: dirs.root,
    };
}

function toMb(bytes: number): number {
    return Number((bytes / (1024 * 1024)).toFixed(1));
}

function metricsOf(measurement: Measurement): Record<string, number> {
    return {
        idleCpuPercent: Number(measurement.main.cpuPercent.toFixed(3)),
        rssMb: toMb(measurement.main.rssBytes),
        threads: measurement.main.threads,
        childProcesses: measurement.childProcesses,
        startupMs: measurement.startupMs,
        treeCpuPercent: Number(measurement.treeCpuPercent.toFixed(3)),
        treeRssMb: toMb(measurement.treeRssBytes),
    };
}

interface MetricStats {
    min: number;
    median: number;
    max: number;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const lower = sorted[middle - 1] ?? 0;
    const upper = sorted[middle] ?? 0;
    return sorted.length % 2 === 0 ? Number(((lower + upper) / 2).toFixed(3)) : upper;
}

/** min/median/max per metric across the runs of one arm. */
function aggregate(runs: Measurement[]): Record<string, MetricStats> {
    const perRun = runs.map(metricsOf);
    const stats: Record<string, MetricStats> = {};

    for (const metric of Object.keys(perRun[0] ?? {})) {
        const values = perRun.map((run) => run[metric] ?? 0);
        stats[metric] = { min: Math.min(...values), median: median(values), max: Math.max(...values) };
    }

    return stats;
}

function medianMetrics(stats: Record<string, MetricStats>): Record<string, number> {
    return Object.fromEntries(Object.entries(stats).map(([metric, stat]) => [metric, stat.median]));
}

async function uptimeLine(): Promise<string> {
    const result = await runCommand(["uptime"]);
    return result.stdout.trim();
}

async function shortSha(): Promise<string> {
    const result = await runCommand(["git", "rev-parse", "--short", "HEAD"]);
    return result.stdout.trim();
}

function renderArm(mode: Mode, runs: Measurement[], stats: Record<string, MetricStats>, windowMs: number): void {
    renderCliHeader("dev-dashboard idle cost", `${mode} mode, ${runs.length} x ${windowMs / 1000}s window`);
    const table = createBoxTable(["METRIC", "MIN", "MEDIAN", "MAX"]);

    for (const [metric, stat] of Object.entries(stats)) {
        table.push([metric, String(stat.min), String(stat.median), String(stat.max)]);
    }

    out.println(table.toString());
    renderCliSection("Runs");

    for (const run of runs) {
        const holders = run.stop.holders.stdout.trim();
        out.println(
            `#${run.round} pid ${run.pid} port ${run.port} load ${run.loadAvgBefore} tree ${run.treePids.join(",")} ` +
                `exit ${run.stop.exitCode}${holders.length === 0 ? " portFree" : " PORT STILL HELD"}`
        );
        out.println(`   logs ${run.logDir}`);
    }
}

function parseModes(raw: string): { modes: Mode[]; invalid: string[] } {
    const requested = raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    const modes: Mode[] = [];
    const invalid: string[] = [];

    for (const value of requested) {
        if (MODES.includes(value as Mode)) {
            if (!modes.includes(value as Mode)) {
                modes.push(value as Mode);
            }
        } else {
            invalid.push(value);
        }
    }

    return { modes, invalid };
}

const program = new Command()
    .name("idle-cost")
    .description("Idle CPU, RSS and thread cost of the dev-dashboard UI server, per serve mode")
    .option("--mode [mode]", `serve mode, comma-separated: ${MODES.join("|")}`, "preview")
    .option("--repeat <n>", "runs per mode; arms are interleaved round-robin", (v) => Number.parseInt(v, 10), 1)
    .option(
        "--window <ms>",
        "idle sampling window; shorten only to smoke the script",
        (v) => Number.parseInt(v, 10),
        DEFAULT_WINDOW_MS
    )
    .option("--baseline", "record each mode's median as the dashboards-idle-<mode> baseline")
    .option("--compare", "compare each mode's median against its baseline; non-zero on a regression")
    .option("--json", "emit the machine-readable result on stdout")
    .action(
        async (opts: {
            mode?: string | boolean;
            repeat: number;
            window: number;
            baseline?: boolean;
            compare?: boolean;
            json?: boolean;
        }) => {
            const raw = typeof opts.mode === "string" ? opts.mode : "";
            const { modes, invalid } = parseModes(raw);

            if (invalid.length > 0 || modes.length === 0) {
                out.println(
                    suggestEnumFlag("bun scripts/benchmarks/dashboards/idle-cost.ts", "--mode", MODES, {
                        given: invalid[0] ?? undefined,
                    })
                );
                process.exitCode = 1;
                return;
            }

            if (!Number.isInteger(opts.repeat) || opts.repeat < 1) {
                out.error("--repeat takes a positive integer.");
                process.exitCode = 1;
                return;
            }

            if (!Number.isInteger(opts.window) || opts.window < 1) {
                out.error("--window takes a positive number of milliseconds.");
                process.exitCode = 1;
                return;
            }

            if (opts.baseline && opts.window < DEFAULT_WINDOW_MS) {
                out.error(
                    `--window ${opts.window} is shorter than the ${DEFAULT_WINDOW_MS}ms a baseline needs; ` +
                        "a smoke-length window cannot be recorded."
                );
                process.exitCode = 1;
                return;
            }

            const uptimeBefore = await uptimeLine();
            out.println(`uptime before: ${uptimeBefore}`);

            // Round-robin, not arm-by-arm: a load change mid-run would otherwise
            // land entirely on one mode and read as a difference between modes.
            const runs = new Map<Mode, Measurement[]>(modes.map((mode) => [mode, []]));

            for (let round = 1; round <= opts.repeat; round += 1) {
                for (const mode of modes) {
                    runs.get(mode)?.push(await measure(mode, round, opts.window));
                }
            }

            const uptimeAfter = await uptimeLine();
            const sha = await shortSha();
            const report: Record<string, unknown>[] = [];
            let failed = false;

            for (const mode of modes) {
                const armRuns = runs.get(mode) ?? [];
                const stats = aggregate(armRuns);
                const metrics = medianMetrics(stats);
                renderArm(mode, armRuns, stats, opts.window);

                const survivors = armRuns.flatMap((run) => run.stop.survivors);

                if (survivors.length > 0) {
                    out.error(`${mode}: benchmark children survived the kill: ${survivors.join(", ")}`);
                    failed = true;
                }

                const name = `dashboards-idle-${mode}`;

                if (opts.baseline) {
                    const notes = [
                        `commit ${sha}`,
                        `median of ${armRuns.length} run(s), ${opts.window / 1000}s window after ${SETTLE_MS / 1000}s settle`,
                        `uptime before: ${uptimeBefore}`,
                        `uptime after: ${uptimeAfter}`,
                    ].join("; ");
                    const baseline = await recordBaseline({ name, metrics, notes });
                    out.println(`recorded baseline ${name} at commit ${baseline.commit}`);
                }

                if (opts.compare) {
                    const cmp = await compareToBaseline({ name, metrics, tolerancePct: 15 });
                    out.println(formatComparison(cmp));

                    if (!cmp.ok) {
                        failed = true;
                    }
                }

                report.push({
                    mode,
                    stats,
                    median: metrics,
                    runs: armRuns.map((run) => ({
                        round: run.round,
                        port: run.port,
                        pid: run.pid,
                        treePids: run.treePids,
                        loadAvgBefore: run.loadAvgBefore,
                        metrics: metricsOf(run),
                        windowMs: run.main.windowMs,
                        exitCode: run.stop.exitCode,
                        forcedKill: run.stop.forcedKill,
                        survivors: run.stop.survivors,
                        portHoldersAfter: run.stop.holders.stdout.trim(),
                        logDir: run.logDir,
                    })),
                });
            }

            out.println(`uptime after:  ${uptimeAfter}`);

            if (failed) {
                process.exitCode = 1;
            }

            if (opts.json) {
                out.result({
                    commit: sha,
                    uptimeBefore,
                    uptimeAfter,
                    repeat: opts.repeat,
                    windowMs: opts.window,
                    arms: report,
                });
            }
        }
    );

await runTool(program, { tool: "bench-dashboards-idle" });
