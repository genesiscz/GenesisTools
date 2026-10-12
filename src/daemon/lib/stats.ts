import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { formatLocalDate, formatLocalFileTimestamp, parseSince, parseUntil, startOfDay } from "@genesiscz/utils/date";
import { parseDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { ripgrepBinary } from "@genesiscz/utils/ripgrep";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { listTasksWithLogs, parseLogFile } from "./log-reader";
import { RUN_LOG_RE, taskLogDirName } from "./run-log-name";
import type { DaemonTask, LogLine, RunReason } from "./types";

const RUN_REASONS: readonly RunReason[] = ["scheduled", "catch-up", "retry"];

/** A meta record's `reason`, or null when the log predates reasons or holds something else. */
function runReason(value: unknown): RunReason | null {
    return RUN_REASONS.find((reason) => reason === value) ?? null;
}

/**
 * `tools daemon stats --json` contract (version 1). The GenesisTools settings window's Daemon pane reads it,
 * so add fields rather than rename or remove them, and bump `version` when a meaning changes.
 *
 * - Times are ISO 8601 UTC strings; durations are milliseconds.
 * - `since: null` means the window has no start (every run log on disk).
 * - A run is `ok` (exit 0), `failed` (any other exit code), `timedOut` (the runner killed it at `timeoutMs`),
 *   `killed` (no exit code and no timeout, so a signal from outside) or `unfinished` (no exit record: it is
 *   still running, or the daemon died under it).
 * - `failureRate` is (failed + timedOut + killed) / finished runs, from 0 to 1; null when nothing finished.
 * - Percentiles are nearest-rank over finished runs; null when nothing finished.
 * - `failures` holds the newest failed, timed-out and killed runs (at most the requested limit, newest first),
 *   each with its last stderr lines; `lastFailure` is `failures[0]`.
 * - `timeline` buckets are local hours when the window spans 48 hours or less, else local days; every task
 *   shares the same bucket starts.
 * - `health` is null when the report did not read it; otherwise it covers at most the last 7 day logs of the window.
 */
export interface DaemonStats {
    version: 1;
    generatedAt: string;
    since: string | null;
    until: string;
    bucket: TimelineUnit;
    logsBaseDir: string;
    totals: RunCounts;
    tasks: TaskStats[];
    health: DaemonHealth | null;
}

export type RunStatus = "ok" | "failed" | "timedOut" | "killed" | "unfinished";
export type TimelineUnit = "hour" | "day";

export interface RunCounts {
    runs: number;
    ok: number;
    failed: number;
    timedOut: number;
    killed: number;
    unfinished: number;
    failureRate: number | null;
}

export interface TaskStats extends RunCounts {
    task: string;
    /** False for a task that has run logs but is no longer in the daemon config. */
    configured: boolean;
    enabled: boolean | null;
    every: string | null;
    timeoutMs: number | null;
    p50Ms: number | null;
    p90Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
    histogram: DurationBucket[];
    timeline: TimelineBucket[];
    lastRun: StatsRun | null;
    lastFailure: StatsRun | null;
    failures: StatsRun[];
    /** The newest runs of any status, newest first, at most 20. */
    recentRuns: StatsRun[];
}

export interface StatsRun {
    task: string;
    runId: string;
    attempt: number;
    startedAt: string;
    status: RunStatus;
    exitCode: number | null;
    durationMs: number | null;
    logFile: string;
    /** The last stderr lines, oldest first; null when this report did not read the run's output. */
    stderrTail: string[] | null;
    /** Why the run happened (scheduled, catch-up, retry); null in logs written before reasons existed. */
    reason: RunReason | null;
}

export interface DurationBucket {
    label: string;
    minMs: number;
    /** Exclusive upper edge; null for the open last bucket. */
    maxMs: number | null;
    count: number;
}

export interface TimelineBucket {
    start: string;
    runs: number;
    /** Failed, timed-out and killed runs that started in this bucket. */
    failures: number;
}

export type HealthKind = "wedged" | "sampledLate" | "taskTimedOut";

export interface HealthEvent {
    ts: string;
    kind: HealthKind;
    task: string | null;
    /** `silentMs` of a wedge or `suspendedMs` of a late watchdog sample. */
    gapMs: number | null;
}

export interface DaemonHealth {
    /** The day logs that were scanned. */
    files: string[];
    wedged: number;
    sampledLate: number;
    taskTimedOut: number;
    /** Newest first, at most 50 of each kind. */
    events: HealthEvent[];
    error: string | null;
}

export interface RunOutput {
    run: StatsRun;
    lines: LogLine[];
}

export interface StatsWindow {
    since: Date | null;
    until: Date;
}

export const DEFAULT_FAILURE_LIMIT = 20;
const RECENT_RUN_LIMIT = 20;
const STDERR_TAIL_LINES = 12;
/** How much of a failed run's log end is read for its stderr tail; a noisy run costs this, not its whole output. */
const STDERR_SCAN_BYTES = 64 * 1024;
const HEALTH_MAX_DAYS = 7;
const HEALTH_EVENT_LIMIT = 50;
const HEALTH_SCAN_TIMEOUT_MS = 30_000;
const HOUR_BUCKET_MAX_SPAN_MS = 48 * 3_600_000;
const MAX_TIMELINE_BUCKETS = 400;
const HEAD_BYTES = 8192;
const TAIL_BYTES = 4096;
/**
 * Run-log names carry the LOCAL start time, which repeats an hour when daylight saving ends. Names are matched
 * against the window with this slack, and the meta record's UTC `startedAt` decides.
 */
const NAME_SLACK_MS = 2 * 3_600_000;

const HISTOGRAM_EDGES_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
const HISTOGRAM_LABELS = ["<1s", "1-2s", "2-5s", "5-10s", "10-30s", "30s-1m", "1-2m", "2-5m", "5-10m", "≥10m"];

const HEALTH_MESSAGES: Array<{ prefix: string; kind: HealthKind }> = [
    { prefix: "[daemon] scheduler wedged", kind: "wedged" },
    { prefix: "[daemon] watchdog sampled late", kind: "sampledLate" },
    { prefix: "[daemon] task timed out", kind: "taskTimedOut" },
];

/**
 * One edge of `--since` / `--until`: `all` (start only), `now`, a duration back from now (`24h`, `7d`, `90m`),
 * or the shared date grammar (`HH:MM`, `YYYY-MM-DD`, an ISO time). A bare date as `--until` is that day's end.
 */
function parseEdge(value: string, edge: "since" | "until", now: Date): Date | null | undefined {
    const text = value.trim();
    const keyword = text.toLowerCase();

    if (keyword === "all" && edge === "since") {
        return null;
    }

    if (keyword === "now") {
        return now;
    }

    const date = edge === "since" ? parseSince(text, now) : parseUntil(text, now);

    if (date) {
        return date;
    }

    const ms = parseDuration(text);
    return ms > 0 ? new Date(now.getTime() - ms) : undefined;
}

/** Throws with a message fit for the user when an edge is unreadable or the window is empty. */
export function resolveWindow(opts: { since?: string; until?: string; now?: Date }): StatsWindow {
    const now = opts.now ?? new Date();
    const since = opts.since === undefined ? null : parseEdge(opts.since, "since", now);
    const until = opts.until === undefined ? now : parseEdge(opts.until, "until", now);

    if (since === undefined) {
        throw new Error(`--since "${opts.since}" is not a duration (24h, 7d), a date, HH:MM, or "all".`);
    }

    if (!until) {
        throw new Error(`--until "${opts.until}" is not a duration (1h), a date, HH:MM, or "now".`);
    }

    if (since && since.getTime() >= until.getTime()) {
        throw new Error("The window is empty: --since must be earlier than --until.");
    }

    return { since, until };
}

function parseRecord(line: string | undefined): Record<string, unknown> | null {
    if (!line?.trim()) {
        return null;
    }

    try {
        const parsed: unknown = SafeJSON.parse(line, { strict: true });
        return isObject(parsed) ? parsed : null;
    } catch (err) {
        logger.debug({ err, lineLength: line.length }, "[daemon-stats] unreadable run-log line");
        return null;
    }
}

/** The meta (first) and exit (last) records of a run log, without reading the output in between. */
function readRunEnds(file: string): { meta: Record<string, unknown> | null; exit: Record<string, unknown> | null } {
    const fd = openSync(file, "r");

    try {
        const size = fstatSync(fd).size;
        const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
        readSync(fd, head, 0, head.length, 0);
        const headText = head.toString("utf-8");
        const firstLine = headText.split("\n", 1)[0];
        let tailText = headText;

        if (size > HEAD_BYTES) {
            const tail = Buffer.alloc(TAIL_BYTES);
            readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
            tailText = tail.toString("utf-8");
        }

        const lines = tailText.trimEnd().split("\n");
        const lastLine = lines.length > 1 || size > HEAD_BYTES ? lines[lines.length - 1] : undefined;
        const exit = parseRecord(lastLine);

        return { meta: parseRecord(firstLine), exit: exit?.type === "exit" ? exit : null };
    } finally {
        closeSync(fd);
    }
}

function classify(exit: Record<string, unknown> | null): Pick<StatsRun, "status" | "exitCode" | "durationMs"> {
    if (!exit) {
        return { status: "unfinished", exitCode: null, durationMs: null };
    }

    const exitCode = typeof exit.code === "number" ? exit.code : null;
    const durationMs = typeof exit.duration_ms === "number" ? exit.duration_ms : null;

    if (exit.timedOut === true) {
        return { status: "timedOut", exitCode, durationMs };
    }

    if (exitCode === null) {
        return { status: "killed", exitCode, durationMs };
    }

    return { status: exitCode === 0 ? "ok" : "failed", exitCode, durationMs };
}

function isFailure(status: RunStatus): boolean {
    return status === "failed" || status === "timedOut" || status === "killed";
}

/** The last stderr lines found in the final `STDERR_SCAN_BYTES` of a run log. */
export function readStderrTail(file: string): string[] {
    let fd: number;

    try {
        fd = openSync(file, "r");
    } catch (err) {
        // The daemon prunes run logs on its own schedule, so a log listed a moment ago can be gone now. A missing tail
        // must not fail the whole report (the `parseLogFile` this replaced returned nothing for a missing file).
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            logger.debug({ file }, "[daemon-stats] run log gone before its stderr read");
            return [];
        }

        throw err;
    }

    try {
        const size = fstatSync(fd).size;
        // One byte early, so a read that starts on a line boundary keeps that line whole.
        const from = Math.max(0, size - STDERR_SCAN_BYTES - 1);
        const buf = Buffer.alloc(size - from);
        const text = buf.toString("utf-8", 0, readSync(fd, buf, 0, buf.length, from));
        const firstBreak = text.indexOf("\n");
        const whole = from === 0 ? text : firstBreak === -1 ? "" : text.slice(firstBreak + 1);

        return whole
            .split("\n")
            .map(parseRecord)
            .flatMap((record) => (record?.type === "stderr" && typeof record.data === "string" ? [record.data] : []))
            .slice(-STDERR_TAIL_LINES);
    } finally {
        closeSync(fd);
    }
}

function inWindow(ms: number, window: StatsWindow): boolean {
    return (window.since === null || ms >= window.since.getTime()) && ms <= window.until.getTime();
}

/** Run-log names inside the window (with the DST slack), oldest first. Names alone decide, so nothing else is opened. */
function runFilesInWindow(taskDir: string, window: StatsWindow): string[] {
    const lower = window.since ? formatLocalFileTimestamp(window.since.getTime() - NAME_SLACK_MS) : null;
    const upper = formatLocalFileTimestamp(window.until.getTime() + NAME_SLACK_MS);

    return readdirSync(taskDir)
        .filter(
            (name) => RUN_LOG_RE.test(name) && (lower === null || name >= lower) && name.slice(0, upper.length) <= upper
        )
        .sort();
}

function readTaskRuns(opts: { logsBaseDir: string; dir: string; task: string; window: StatsWindow }): StatsRun[] {
    const taskDir = join(opts.logsBaseDir, opts.dir);

    if (!existsSync(taskDir)) {
        return [];
    }

    const files = runFilesInWindow(taskDir, opts.window);
    const runs: StatsRun[] = [];
    let unreadable = 0;

    for (const name of files) {
        const logFile = join(taskDir, name);

        try {
            const { meta, exit } = readRunEnds(logFile);
            const startedMs = typeof meta?.startedAt === "string" ? Date.parse(meta.startedAt) : Number.NaN;

            if (meta?.type !== "meta" || !Number.isFinite(startedMs)) {
                unreadable++;
                continue;
            }

            if (!inWindow(startedMs, opts.window)) {
                continue;
            }

            runs.push({
                task: opts.task,
                runId: typeof meta.runId === "string" ? meta.runId : name.replace(/\.jsonl$/, ""),
                attempt: typeof meta.attempt === "number" ? meta.attempt : 1,
                startedAt: new Date(startedMs).toISOString(),
                ...classify(exit),
                logFile,
                stderrTail: null,
                reason: runReason(meta.reason),
            });
        } catch (err) {
            unreadable++;
            logger.debug({ err, file: logFile }, "[daemon-stats] run log could not be read");
        }
    }

    logger.debug(
        { task: opts.task, files: files.length, runs: runs.length, unreadable },
        "[daemon-stats] task run logs read"
    );

    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], q: number): number | null {
    if (sorted.length === 0) {
        return null;
    }

    return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

function buildHistogram(durations: number[]): DurationBucket[] {
    const buckets = HISTOGRAM_LABELS.map((label, i) => ({
        label,
        minMs: i === 0 ? 0 : HISTOGRAM_EDGES_MS[i - 1],
        maxMs: HISTOGRAM_EDGES_MS[i] ?? null,
        count: 0,
    }));

    for (const ms of durations) {
        const index = HISTOGRAM_EDGES_MS.findIndex((edge) => ms < edge);
        buckets[index === -1 ? buckets.length - 1 : index].count++;
    }

    return buckets;
}

function floorToUnit(ms: number, unit: TimelineUnit): Date {
    const date = new Date(ms);
    date.setMinutes(0, 0, 0);

    if (unit === "day") {
        date.setHours(0);
    }

    return date;
}

/** Local hour or day starts from the window start (or the first run) to the window end, at most 400 of them. */
function timelineStarts(window: StatsWindow, firstRunMs: number | null): { unit: TimelineUnit; starts: number[] } {
    const startMs = window.since?.getTime() ?? firstRunMs ?? window.until.getTime();
    const unit: TimelineUnit = window.until.getTime() - startMs <= HOUR_BUCKET_MAX_SPAN_MS ? "hour" : "day";
    const starts: number[] = [];
    const cursor = floorToUnit(startMs, unit);

    while (cursor.getTime() <= window.until.getTime()) {
        starts.push(cursor.getTime());

        if (unit === "hour") {
            // Elapsed time, not the local clock: the hour that repeats when daylight saving time ends is its own bucket.
            cursor.setTime(cursor.getTime() + 3_600_000);
        } else {
            cursor.setDate(cursor.getDate() + 1);
        }
    }

    return { unit, starts: starts.slice(-MAX_TIMELINE_BUCKETS) };
}

function buildTimeline(runs: StatsRun[], starts: number[]): TimelineBucket[] {
    const buckets = starts.map((start) => ({ start: new Date(start).toISOString(), runs: 0, failures: 0 }));
    let index = 0;

    for (const run of runs) {
        const ms = Date.parse(run.startedAt);

        if (starts.length === 0 || ms < starts[0]) {
            continue;
        }

        while (index + 1 < starts.length && starts[index + 1] <= ms) {
            index++;
        }

        buckets[index].runs++;

        if (isFailure(run.status)) {
            buckets[index].failures++;
        }
    }

    return buckets;
}

export function failedRuns(counts: RunCounts): number {
    return counts.failed + counts.timedOut + counts.killed;
}

export function finishedRuns(counts: RunCounts): number {
    return counts.runs - counts.unfinished;
}

function countRuns(runs: Array<Pick<StatsRun, "status">>): RunCounts {
    const counts: RunCounts = {
        runs: runs.length,
        ok: 0,
        failed: 0,
        timedOut: 0,
        killed: 0,
        unfinished: 0,
        failureRate: null,
    };

    for (const run of runs) {
        counts[run.status]++;
    }

    const finished = finishedRuns(counts);
    counts.failureRate = finished > 0 ? failedRuns(counts) / finished : null;
    return counts;
}

/**
 * Run statistics for a window. Reads only the run logs whose names fall inside the window, and from each only
 * the meta and exit records; the stderr of the newest `failureLimit` failures per task is the only output read.
 */
export function collectDaemonStats(opts: {
    logsBaseDir: string;
    tasks: DaemonTask[];
    window: StatsWindow;
    /** Only this task (a configured name or a run-log folder). */
    task?: string;
    failureLimit?: number;
    health?: DaemonHealth | null;
    now?: Date;
}): DaemonStats {
    const failureLimit = opts.failureLimit ?? DEFAULT_FAILURE_LIMIT;
    const configured = new Map(opts.tasks.map((task) => [taskLogDirName(task.name), task]));
    const dirs = new Set([...configured.keys(), ...listTasksWithLogs(opts.logsBaseDir)]);
    const perTask = [...dirs]
        .map((dir) => ({ dir, config: configured.get(dir), name: configured.get(dir)?.name ?? dir }))
        .filter((entry) => opts.task === undefined || entry.name === opts.task || entry.dir === opts.task)
        .map((entry) => ({
            ...entry,
            runs: readTaskRuns({
                logsBaseDir: opts.logsBaseDir,
                dir: entry.dir,
                task: entry.name,
                window: opts.window,
            }),
        }))
        .filter((entry) => entry.config || entry.runs.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));

    const firsts = perTask.flatMap((entry) => (entry.runs[0] ? [Date.parse(entry.runs[0].startedAt)] : []));
    const firstRunMs = firsts.length > 0 ? Math.min(...firsts) : null;
    const { unit, starts } = timelineStarts(opts.window, firstRunMs);

    const tasks = perTask.map(({ name, config, runs }): TaskStats => {
        const durations = runs
            .flatMap((run) => (run.durationMs === null ? [] : [run.durationMs]))
            .sort((a, b) => a - b);
        const newestFirst = [...runs].reverse();
        const failures = newestFirst
            .filter((run) => isFailure(run.status))
            .slice(0, failureLimit)
            .map((run) => ({ ...run, stderrTail: readStderrTail(run.logFile) }));

        return {
            task: name,
            configured: config !== undefined,
            enabled: config?.enabled ?? null,
            every: config?.every ?? null,
            timeoutMs: config?.timeoutMs ?? null,
            ...countRuns(runs),
            p50Ms: percentile(durations, 0.5),
            p90Ms: percentile(durations, 0.9),
            p99Ms: percentile(durations, 0.99),
            maxMs: durations.at(-1) ?? null,
            histogram: buildHistogram(durations),
            timeline: buildTimeline(runs, starts),
            lastRun: newestFirst[0] ?? null,
            lastFailure: failures[0] ?? null,
            failures,
            recentRuns: newestFirst.slice(0, RECENT_RUN_LIMIT),
        };
    });

    return {
        version: 1,
        generatedAt: (opts.now ?? new Date()).toISOString(),
        since: opts.window.since?.toISOString() ?? null,
        until: opts.window.until.toISOString(),
        bucket: unit,
        logsBaseDir: opts.logsBaseDir,
        totals: countRuns(perTask.flatMap((entry) => entry.runs)),
        tasks,
        health: opts.health ?? null,
    };
}

/** The full output of one run, found by its id (the run-log name ends in `-<runId>.jsonl`). */
export function readRunOutput(opts: { logsBaseDir: string; runId: string; task?: string }): RunOutput | null {
    const suffix = `-${opts.runId}.jsonl`;
    const dirs = opts.task ? [taskLogDirName(opts.task)] : listTasksWithLogs(opts.logsBaseDir);

    for (const dir of dirs) {
        const taskDir = join(opts.logsBaseDir, dir);

        if (!existsSync(taskDir)) {
            continue;
        }

        const name = readdirSync(taskDir).find((file) => file.endsWith(suffix));

        if (!name) {
            continue;
        }

        const logFile = join(taskDir, name);
        const entries = parseLogFile(logFile);
        const meta = entries.find((entry) => entry.type === "meta");
        const exit = entries.find((entry) => entry.type === "exit");
        const lines = entries.filter((entry): entry is LogLine => entry.type === "stdout" || entry.type === "stderr");

        return {
            run: {
                task: meta?.taskName ?? opts.task ?? dir,
                runId: opts.runId,
                attempt: meta?.attempt ?? 1,
                startedAt: meta?.startedAt ?? "",
                ...classify(exit ? { ...exit } : null),
                logFile,
                stderrTail: null,
                reason: runReason(meta?.reason),
            },
            lines,
        };
    }

    return null;
}

function emptyHealth(files: string[]): DaemonHealth {
    return { files, wedged: 0, sampledLate: 0, taskTimedOut: 0, events: [], error: null };
}

/** Count the daemon's own health lines among day-log records (pino JSON lines), keeping those inside the window. */
export function summarizeHealthLines(opts: {
    lines: Iterable<string>;
    window: StatsWindow;
    files: string[];
}): DaemonHealth {
    const { lines, window, files } = opts;
    const health = emptyHealth(files);

    for (const line of lines) {
        const record = parseRecord(line);
        const msg = typeof record?.msg === "string" ? record.msg : "";
        const kind = HEALTH_MESSAGES.find((entry) => msg.startsWith(entry.prefix))?.kind;
        const ms = typeof record?.time === "string" ? Date.parse(record.time) : Number.NaN;

        if (!record || !kind || !Number.isFinite(ms) || !inWindow(ms, window)) {
            continue;
        }

        health[kind]++;
        const gap = record.silentMs ?? record.suspendedMs;
        health.events.push({
            ts: new Date(ms).toISOString(),
            kind,
            task: typeof record.task === "string" ? record.task : null,
            gapMs: typeof gap === "number" ? gap : null,
        });
    }

    // The cap is per kind, so a burst of timeouts cannot push the rare wedge out of the list.
    const kept: Record<HealthKind, number> = { wedged: 0, sampledLate: 0, taskTimedOut: 0 };
    health.events = health.events
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .filter((event) => ++kept[event.kind] <= HEALTH_EVENT_LIMIT);
    return health;
}

/**
 * The daemon's health lines from the day logs (`~/.genesis-tools/logs/<local date>.log`) that overlap the
 * window, at most the last 7. A day log can pass 1 GB, so `rg` filters it and only matching lines reach here.
 */
export async function readDaemonHealth(window: StatsWindow): Promise<DaemonHealth> {
    const logsDir = genesisToolsDir("logs");
    const lastDay = startOfDay(window.until);
    const weekBack = new Date(lastDay);
    weekBack.setDate(weekBack.getDate() - (HEALTH_MAX_DAYS - 1));
    const firstDay = window.since && window.since.getTime() > weekBack.getTime() ? startOfDay(window.since) : weekBack;

    const files: string[] = [];

    for (const day = new Date(firstDay); day.getTime() <= lastDay.getTime(); day.setDate(day.getDate() + 1)) {
        const file = join(logsDir, `${formatLocalDate(day)}.log`);

        if (existsSync(file)) {
            files.push(file);
        }
    }

    const empty = emptyHealth(files);

    if (files.length === 0) {
        return empty;
    }

    const rg = ripgrepBinary();

    if (!rg) {
        return { ...empty, error: "rg is not on PATH, so the day logs were not scanned" };
    }

    const patterns = HEALTH_MESSAGES.flatMap((entry) => ["-e", entry.prefix]);
    const proc = Bun.spawn(
        [rg, "--no-config", "--no-filename", "--no-line-number", "-F", ...patterns, "--", ...files],
        {
            stdout: "pipe",
            stderr: "pipe",
            timeout: HEALTH_SCAN_TIMEOUT_MS,
        }
    );
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    logger.debug({ files, code, signal: proc.signalCode, bytes: stdout.length }, "[daemon-stats] day-log health scan");

    // rg exits 1 when nothing matched.
    if (proc.signalCode || code > 1) {
        const reason = proc.signalCode ? `was stopped by ${proc.signalCode}` : `exited ${code}: ${stderr.trim()}`;
        return { ...empty, error: `rg ${reason}` };
    }

    return summarizeHealthLines({ lines: stdout.split("\n"), window, files });
}
