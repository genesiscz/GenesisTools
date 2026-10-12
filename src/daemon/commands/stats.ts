import { isInteractive, suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { formatLocalDate, formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { formatDuration } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import {
    createBoxTable,
    type DotStatusKind,
    formatDotStatus,
    renderCliHeader,
    renderCliKeyRow,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { getLogsBaseDir, loadConfig } from "../lib/config";
import { listTasksWithLogs } from "../lib/log-reader";
import {
    collectDaemonStats,
    type DaemonHealth,
    type DaemonStats,
    DEFAULT_FAILURE_LIMIT,
    failedRuns,
    finishedRuns,
    type RunCounts,
    type RunOutput,
    type RunStatus,
    readDaemonHealth,
    readRunOutput,
    resolveWindow,
    type StatsRun,
    type StatsWindow,
    type TaskStats,
} from "../lib/stats";
import type { DaemonTask } from "../lib/types";

const TOOL = "tools daemon stats";
const SUBCOMMAND = ["stats"];
const DEFAULT_SINCE = "24h";
const TIMELINE_ROWS = 48;
const BAR_WIDTH = 30;
const LINE_WIDTH = 110;

const VIEW_OPTIONS = [
    { value: "overview", label: "Overview", hint: "every task: runs, failure rate, durations, daemon health" },
    { value: "task", label: "One task", hint: "counts, duration histogram, runs over time, last failure" },
    { value: "durations", label: "Durations", hint: "percentiles and histogram per task" },
    { value: "failures", label: "Failures", hint: "failed, timed-out and killed runs with their stderr" },
    { value: "run", label: "Output of one run", hint: "the full stdout and stderr" },
] as const;
type StatsView = (typeof VIEW_OPTIONS)[number]["value"];
const VIEWS = VIEW_OPTIONS.map((option) => option.value);
const KEY_WIDTH = 14;
const COUNT_HEADERS = ["RUNS", "OK", "FAILED", "TIMEOUT", "KILLED", "OPEN", "FAIL %"];
const PERCENTILE_HEADERS = ["P50", "P90", "P99", "MAX"];
const STATUS_KIND: Record<RunStatus, DotStatusKind> = {
    ok: "ok",
    failed: "err",
    timedOut: "warn",
    killed: "err",
    unfinished: "dim",
};

const WINDOW_PRESETS: Array<{ value: string; label: string }> = [
    { value: "1h", label: "Last hour" },
    { value: "24h", label: "Last 24 hours" },
    { value: "7d", label: "Last 7 days" },
    { value: "all", label: "All run logs" },
];

interface StatsFlags {
    view?: string | true;
    task?: string;
    since: string;
    until?: string;
    run?: string;
    json?: boolean;
}

interface Filters {
    since: string;
    until?: string;
    task?: string;
    run?: string;
}

export function registerStatsCommand(program: Command): void {
    program
        .command("stats")
        .description("Task run statistics: failure rates, durations, failures with their stderr, run output")
        .option("--view [view]", `What to show: ${VIEWS.join(", ")}`)
        .option("-t, --task <name>", "Only this task")
        .option(
            "--since <when>",
            "Window start: a duration (1h, 24h, 7d), a date or ISO time, HH:MM, or all",
            DEFAULT_SINCE
        )
        .option("--until <when>", "Window end: a duration back from now, a date or ISO time, HH:MM (default: now)")
        .option("--run <runId>", "The run to print with --view run")
        .option("--json", "Print the stats as JSON (the shape is documented on DaemonStats in lib/stats.ts)")
        .action(async (opts: StatsFlags) => {
            await runStats(opts);
        });
}

function isView(value: unknown): value is StatsView {
    return VIEWS.some((view) => view === value);
}

function failView(given?: string): void {
    out.error(suggestEnumFlag(TOOL, "--view", VIEWS, { subcommand: SUBCOMMAND, given }));
    process.exitCode = 1;
}

async function runStats(opts: StatsFlags): Promise<void> {
    const filters: Filters = { since: opts.since, until: opts.until, task: opts.task, run: opts.run };
    const error = windowError(filters.since, filters.until);

    if (error) {
        out.error(error);
        process.exitCode = 1;
        return;
    }

    if (opts.view === true || opts.view === "") {
        if (isInteractive() && !opts.json) {
            await runMenu(filters);
            return;
        }

        failView();
        return;
    }

    if (opts.view !== undefined && !isView(opts.view)) {
        failView(opts.view);
        return;
    }

    if (opts.view === undefined && !opts.json && opts.run === undefined && isInteractive()) {
        await runMenu(filters);
        return;
    }

    const view: StatsView = opts.view ?? (opts.run ? "run" : opts.task ? "task" : "overview");
    await showView({ view, filters, json: Boolean(opts.json) });
}

/** Prints one view; a missing input or an unknown task sets exit code 1 with the fix. */
async function showView(opts: { view: StatsView; filters: Filters; json: boolean }): Promise<void> {
    const { view, filters, json } = opts;
    const window = resolveWindow(filters);
    const logsBaseDir = getLogsBaseDir();

    if (view === "run") {
        if (!filters.run) {
            out.error(`--view run needs a run id. Run ids are in the RUN column of --view failures.`);
            out.error(suggestCommand(TOOL, { subcommand: SUBCOMMAND, add: ["--run", "<runId>"] }));
            process.exitCode = 1;
            return;
        }

        const output = readRunOutput({ logsBaseDir, runId: filters.run, task: filters.task });

        if (!output) {
            out.error(`No run log with id "${filters.run}"${filters.task ? ` for task "${filters.task}"` : ""}.`);
            process.exitCode = 1;
            return;
        }

        if (json) {
            out.result(output);
            return;
        }

        renderRun(output);
        return;
    }

    if (view === "task" && !filters.task) {
        const names = taskNames((await loadConfig()).tasks, logsBaseDir);
        out.error(`--view task needs --task. Tasks: ${names.join(", ")}`);
        out.error(suggestCommand(TOOL, { subcommand: SUBCOMMAND, add: ["--task", names[0] ?? "<name>"] }));
        process.exitCode = 1;
        return;
    }

    const stats = await loadStats({ view, window, task: filters.task, json });

    if (filters.task && stats.tasks.length === 0) {
        out.error(`No task "${filters.task}" in the daemon config or with runs in this window.`);
        process.exitCode = 1;
        return;
    }

    if (json) {
        out.result(stats);
        return;
    }

    renderStatsView(view, stats);
}

function renderStatsView(view: Exclude<StatsView, "run">, stats: DaemonStats): void {
    switch (view) {
        case "overview":
            renderOverview(stats);
            break;
        case "task":
            for (const task of stats.tasks) {
                renderTask(task, stats);
            }

            break;
        case "durations":
            renderDurations(stats);
            break;
        case "failures":
            renderFailures(stats);
            break;
    }
}

/** Overview and task show one failure per task, so they read one stderr tail each unless the JSON report wants them all. */
async function loadStats(opts: {
    view: StatsView;
    window: StatsWindow;
    task?: string;
    json: boolean;
}): Promise<DaemonStats> {
    // The day-log scan is an rg child process, so it runs while the run logs are read.
    const health = opts.view === "overview" ? readDaemonHealth(opts.window) : null;
    const config = await loadConfig();
    const stats = collectDaemonStats({
        logsBaseDir: getLogsBaseDir(),
        tasks: config.tasks,
        window: opts.window,
        task: opts.task,
        failureLimit: !opts.json && (opts.view === "overview" || opts.view === "task") ? 1 : DEFAULT_FAILURE_LIMIT,
    });
    return { ...stats, health: health ? await health : null };
}

function taskNames(tasks: DaemonTask[], logsBaseDir: string): string[] {
    return [...new Set([...tasks.map((task) => task.name), ...listTasksWithLogs(logsBaseDir)])].sort();
}

// ---- Interactive loop ----

function windowLabel(filters: Filters): string {
    const preset = WINDOW_PRESETS.find((entry) => entry.value === filters.since && !filters.until);

    if (preset) {
        return preset.label.toLowerCase();
    }

    return `since ${filters.since}${filters.until ? ` until ${filters.until}` : ""}`;
}

function windowError(since: string, until?: string): string | undefined {
    try {
        resolveWindow({ since, until });
        return undefined;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

async function pickWindow(current: Filters): Promise<Pick<Filters, "since" | "until">> {
    const picked = String(
        await p.select({
            message: "Window",
            options: [...WINDOW_PRESETS, { value: "custom", label: "Custom", hint: "type a start and an end" }],
            initialValue: current.until ? "custom" : current.since,
        })
    );

    if (picked !== "custom") {
        return { since: picked, until: undefined };
    }

    const since = await p.text({
        message: "Since (1h, 7d, 2026-10-01, 2026-10-01T08:00, 09:30, all)",
        initialValue: current.since,
        validate: (value) => windowError(value),
    });
    const until = await p.text({
        message: "Until (empty = now)",
        initialValue: current.until ?? "",
        validate: (value) => (value.trim() ? windowError(since, value) : undefined),
    });

    return { since, until: until.trim() || undefined };
}

async function pickTask(opts: { names: string[]; current?: string; allowAll: boolean }): Promise<string | undefined> {
    const options = opts.names.map((name) => ({ value: name, label: name }));
    const picked = String(
        await p.select({
            message: "Task",
            options: opts.allowAll ? [{ value: "", label: "All tasks" }, ...options] : options,
            initialValue: opts.current ?? (opts.allowAll ? "" : opts.names[0]),
        })
    );

    return picked || undefined;
}

async function pickRun(task: TaskStats): Promise<string | undefined> {
    const byId = new Map([...task.failures, ...task.recentRuns].map((run) => [run.runId, run]));
    const runs = [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (runs.length === 0) {
        p.log.info(`No runs of ${task.task} in this window.`);
        return undefined;
    }

    const picked = await p.select({
        message: "Run (failures and the newest runs)",
        options: runs.map((run) => ({
            value: run.runId,
            label: `${shortTime(run.startedAt)}  ${statusLabel(run)}`,
            hint: `${formatMs(run.durationMs)} · ${run.runId}`,
        })),
    });

    return String(picked);
}

/** The menu comes back after every view with the same window and task, until Done. */
async function runMenu(initial: Filters): Promise<void> {
    const filters: Filters = { ...initial };
    const names = taskNames((await loadConfig()).tasks, getLogsBaseDir());
    let last: string = VIEW_OPTIONS[0].value;

    p.intro(pc.bgCyan(pc.black(" daemon stats ")));

    while (true) {
        const choice = String(
            await p.select({
                message: `Show (${windowLabel(filters)}${filters.task ? ` · last task ${filters.task}` : ""})`,
                options: [
                    ...VIEW_OPTIONS,
                    { value: "window", label: "Change window", hint: windowLabel(filters) },
                    { value: "done", label: "Done" },
                ],
                initialValue: last,
            })
        );
        last = choice;

        if (choice === "done") {
            p.outro(pc.dim("Bye"));
            return;
        }

        if (choice === "window") {
            Object.assign(filters, await pickWindow(filters));
            continue;
        }

        if (!isView(choice)) {
            continue;
        }

        await showMenuView({ view: choice, filters, names });
        out.println("");
    }
}

async function showMenuView(opts: { view: StatsView; filters: Filters; names: string[] }): Promise<void> {
    const { view, filters, names } = opts;
    let scope: string | undefined;

    if (view === "task" || view === "run") {
        filters.task = await pickTask({ names, current: filters.task, allowAll: false });
        scope = filters.task;
    } else if (view === "durations" || view === "failures") {
        scope = await pickTask({ names, current: filters.task, allowAll: true });
        filters.task = scope ?? filters.task;
    }

    const window = resolveWindow(filters);
    const spinner = p.spinner();
    spinner.start("Reading run logs");
    const stats = await loadStats({ view, window, task: scope, json: false });
    spinner.stop(`${stats.totals.runs} runs in ${windowLabel(filters)}`);

    if (view !== "run") {
        renderStatsView(view, stats);
        return;
    }

    const task = stats.tasks[0];

    if (!task) {
        p.log.info(`No runs of ${scope} in ${windowLabel(filters)}.`);
        return;
    }

    const runId = await pickRun(task);
    const output = runId ? readRunOutput({ logsBaseDir: getLogsBaseDir(), runId, task: task.task }) : null;

    if (output) {
        renderRun(output);
    }
}

// ---- Rendering ----

function shortTime(iso: string): string {
    return formatLocalDateTimeStamp(iso, { seconds: false }).slice(5);
}

function formatMs(ms: number | null): string {
    return ms === null ? "—" : formatDuration(ms);
}

function formatRate(rate: number | null): string {
    if (rate === null) {
        return pc.dim("—");
    }

    const text = `${(rate * 100).toFixed(1)}%`;

    if (rate === 0) {
        return pc.green(text);
    }

    return rate < 0.1 ? pc.yellow(text) : pc.red(text);
}

function formatCount(count: number, color: (text: string) => string): string {
    return count === 0 ? pc.dim("0") : color(String(count));
}

function statusLabel(run: Pick<StatsRun, "status" | "exitCode">): string {
    switch (run.status) {
        case "ok":
            return "ok";
        case "failed":
            return `exit ${run.exitCode}`;
        case "timedOut":
            return "timed out";
        case "killed":
            return "killed";
        case "unfinished":
            return "unfinished";
    }
}

function statusDot(run: Pick<StatsRun, "status" | "exitCode">): string {
    return formatDotStatus(STATUS_KIND[run.status], statusLabel(run));
}

function countCells(counts: RunCounts): string[] {
    return [
        String(counts.runs),
        formatCount(counts.ok, pc.green),
        formatCount(counts.failed, pc.red),
        formatCount(counts.timedOut, pc.yellow),
        formatCount(counts.killed, pc.red),
        formatCount(counts.unfinished, pc.dim),
        formatRate(counts.failureRate),
    ];
}

function percentileCells(task: TaskStats): string[] {
    return [task.p50Ms, task.p90Ms, task.p99Ms, task.maxMs].map(formatMs);
}

/** Fits the header box, which cuts its subtitle at 31 characters. */
function windowRange(stats: DaemonStats): string {
    return stats.since ? `${shortTime(stats.since)} → ${shortTime(stats.until)}` : "all run logs";
}

/** A bar scaled to `max`, its last `failures` cells red; one cell at least for any non-zero count. */
function bar(opts: { count: number; max: number; failures?: number; color: (text: string) => string }): string {
    const failures = opts.failures ?? 0;
    const scaled = opts.max === 0 ? 0 : Math.round((opts.count / opts.max) * BAR_WIDTH);
    const width = opts.count > 0 ? Math.max(1, scaled) : 0;
    const red = failures > 0 ? Math.max(1, Math.round((failures / opts.count) * width)) : 0;
    return opts.color("█".repeat(width - red)) + pc.red("█".repeat(red));
}

function renderOverview(stats: DaemonStats): void {
    const { totals } = stats;
    renderCliHeader("Daemon stats", windowRange(stats));

    const table = createBoxTable(["TASK", ...COUNT_HEADERS, "P50", "P90", "MAX", "LAST RUN"]);

    for (const task of stats.tasks) {
        const name = task.configured && task.enabled !== false ? pc.white(task.task) : pc.dim(task.task);
        table.push([
            name,
            ...countCells(task),
            formatMs(task.p50Ms),
            formatMs(task.p90Ms),
            formatMs(task.maxMs),
            task.lastRun
                ? formatDotStatus(STATUS_KIND[task.lastRun.status], shortTime(task.lastRun.startedAt))
                : pc.dim("—"),
        ]);
    }

    out.println(table.toString());
    out.println(
        `  ${totals.runs} runs · ${failedRuns(totals)} failed (${formatRate(totals.failureRate)}) · ${totals.unfinished} unfinished`
    );

    const lastFailures = stats.tasks.flatMap((task) => (task.lastFailure ? [task.lastFailure] : []));

    if (lastFailures.length > 0) {
        out.println("");
        renderCliSection("Last failure per task");

        for (const run of lastFailures) {
            renderRunLine(run);
            renderStderr(run.stderrTail?.slice(-3) ?? []);
        }
    }

    renderHealth(stats.health);
    out.println("");
    out.println(
        pc.dim(`  More: ${TOOL} --view task|durations|failures|run --task <name>   (no flags in a terminal = menu)`)
    );
}

function renderRunLine(run: StatsRun): void {
    out.println(
        `  ${pc.bold(run.task)}  ${shortTime(run.startedAt)}  ${statusDot(run)}  ${pc.dim(`${formatMs(run.durationMs)} · run ${run.runId}`)}`
    );
}

function renderStderr(lines: string[]): void {
    for (const line of lines) {
        out.println(pc.dim(`      ${truncateDisplay(line, LINE_WIDTH)}`));
    }
}

function renderHealth(health: DaemonHealth | null): void {
    if (!health) {
        return;
    }

    out.println("");
    renderCliSection("Daemon health (day logs)");

    if (health.error) {
        renderCliKeyRow("error", pc.yellow(health.error), KEY_WIDTH);
    }

    renderCliKeyRow("wedged", formatCount(health.wedged, pc.red), KEY_WIDTH);
    renderCliKeyRow("late watchdog", formatCount(health.sampledLate, pc.yellow), KEY_WIDTH);
    renderCliKeyRow("timeouts", `${formatCount(health.taskTimedOut, pc.yellow)} ${pc.dim("SIGTERM sent")}`, KEY_WIDTH);
    renderCliKeyRow("scanned", pc.dim(`${health.files.length} day log(s)`), KEY_WIDTH);

    // Timeouts are already counted per task above; the list shows wedges and late samples.
    for (const event of health.events.filter((entry) => entry.kind !== "taskTimedOut").slice(0, 5)) {
        const task = event.task ? ` ${event.task}` : "";
        const gap = event.gapMs === null ? "" : ` gap ${formatDuration(event.gapMs)}`;
        out.println(pc.dim(`  ${shortTime(event.ts)}  ${event.kind}${task}${gap}`));
    }
}

function renderHistogram(task: TaskStats): void {
    const max = Math.max(...task.histogram.map((bucket) => bucket.count));

    for (const bucket of task.histogram) {
        const cells = bar({ count: bucket.count, max, color: pc.cyan });
        out.println(`  ${bucket.label.padEnd(7)} ${cells} ${pc.dim(String(bucket.count))}`);
    }
}

function renderTimeline(task: TaskStats, unit: DaemonStats["bucket"]): void {
    const rows = task.timeline.slice(-TIMELINE_ROWS);
    const max = Math.max(...rows.map((bucket) => bucket.runs));

    if (rows.length < task.timeline.length) {
        out.println(pc.dim(`  (the last ${rows.length} of ${task.timeline.length} ${unit}s)`));
    }

    for (const bucket of rows) {
        const label = unit === "hour" ? shortTime(bucket.start) : formatLocalDate(new Date(bucket.start));
        const cells = bar({ count: bucket.runs, max, failures: bucket.failures, color: pc.green });
        const failures = bucket.failures > 0 ? pc.red(` (${bucket.failures} failed)`) : "";
        out.println(`  ${label.padEnd(11)} ${cells} ${pc.dim(String(bucket.runs))}${failures}`);
    }
}

function renderTask(task: TaskStats, stats: DaemonStats): void {
    renderCliHeader(task.task, windowRange(stats));
    renderCliKeyRow(
        "schedule",
        task.configured ? `${task.every} · ${task.enabled ? "enabled" : "disabled"}` : "not in the daemon config"
    );

    if (task.timeoutMs) {
        renderCliKeyRow("timeout", formatDuration(task.timeoutMs));
    }

    out.println("");

    const table = createBoxTable([...COUNT_HEADERS, ...PERCENTILE_HEADERS]);
    table.push([...countCells(task), ...percentileCells(task)]);
    out.println(table.toString());

    if (task.runs === 0) {
        return;
    }

    out.println("");
    renderCliSection("Durations");
    renderHistogram(task);
    out.println("");
    renderCliSection(`Runs per ${stats.bucket}`);
    renderTimeline(task, stats.bucket);

    if (task.lastRun) {
        out.println("");
        renderCliSection("Last run");
        renderRunLine(task.lastRun);
    }

    if (task.lastFailure) {
        out.println("");
        renderCliSection("Last failure");
        renderRunLine(task.lastFailure);
        renderStderr(task.lastFailure.stderrTail ?? []);
    }
}

function renderDurations(stats: DaemonStats): void {
    renderCliHeader("Run durations", windowRange(stats));

    const table = createBoxTable(["TASK", "FINISHED", ...PERCENTILE_HEADERS]);

    for (const task of stats.tasks) {
        table.push([task.task, String(finishedRuns(task)), ...percentileCells(task)]);
    }

    out.println(table.toString());

    for (const task of stats.tasks.filter((entry) => entry.maxMs !== null)) {
        out.println("");
        renderCliSection(task.task);
        renderHistogram(task);
    }
}

function renderFailures(stats: DaemonStats): void {
    renderCliHeader("Failures", windowRange(stats));
    const failing = stats.tasks.filter((task) => task.failures.length > 0);

    if (failing.length === 0) {
        p.log.success("No failed, timed-out or killed runs in this window.");
        return;
    }

    for (const task of failing) {
        const total = failedRuns(task);
        renderCliSection(
            `${task.task}: ${total} of ${finishedRuns(task)} finished runs (${task.failed} failed, ${task.timedOut} timed out, ${task.killed} killed)`
        );

        if (task.failures.length < total) {
            out.println(pc.dim(`  the newest ${task.failures.length} of ${total}`));
        }

        const table = createBoxTable(["STARTED", "RUN", "TRY", "STATUS", "DURATION", "LAST STDERR LINE"]);

        for (const run of task.failures) {
            table.push([
                shortTime(run.startedAt),
                run.runId,
                String(run.attempt),
                statusDot(run),
                formatMs(run.durationMs),
                pc.dim(truncateDisplay(run.stderrTail?.at(-1), 60)),
            ]);
        }

        out.println(table.toString());
        out.println(pc.dim(`  stderr of the newest failure (run ${task.failures[0].runId}):`));
        renderStderr(task.failures[0].stderrTail ?? []);
        out.println("");
    }

    out.println(pc.dim(`  Full output: ${TOOL} --view run --run <RUN>`));
}

function renderRun(output: RunOutput): void {
    const { run, lines } = output;
    renderCliHeader(run.task, `run ${run.runId}`);
    renderCliKeyRow("started", run.startedAt ? formatLocalDateTimeStamp(run.startedAt) : "—");
    renderCliKeyRow("try", String(run.attempt));
    renderCliKeyRow("outcome", `${statusDot(run)} ${pc.dim(formatMs(run.durationMs))}`);
    out.println("");

    if (lines.length === 0) {
        out.println(pc.dim("  (no output)"));
    }

    for (const line of lines) {
        out.println(line.type === "stderr" ? pc.yellow(line.data) : line.data);
    }

    out.println(pc.dim(`\n  ${run.logFile}`));
}
