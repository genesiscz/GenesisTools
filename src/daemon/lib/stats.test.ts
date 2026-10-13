import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressFile } from "@genesiscz/utils/compress/file";
import { formatLocalFileTimestamp } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { ripgrepBinary } from "@genesiscz/utils/ripgrep";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { withTimeZone } from "@genesiscz/utils/test/timezone";
import {
    collectDaemonStats,
    readDaemonHealth,
    readRunOutput,
    readStderrTail,
    resolveWindow,
    type StatsWindow,
    summarizeHealthLines,
    type TimelineUnit,
    timelineStarts,
} from "./stats";
import type { DaemonTask } from "./types";

const NOW = new Date("2026-10-12T00:00:00.000Z");
const base = mkdtempSync(join(tmpdir(), "daemon-stats-test-"));

interface FixtureRun {
    task: string;
    runId: string;
    startedAt: string;
    exit?: { code: number | null; durationMs: number; timedOut?: boolean };
    stdout?: string[];
    stderr?: string[];
    /** Overrides the file name, which otherwise carries `startedAt` in local time like the runner's. */
    fileStamp?: string;
}

function writeRun(dir: string, run: FixtureRun): void {
    const taskDir = join(dir, run.task);
    mkdirSync(taskDir, { recursive: true });
    const lines: Array<Record<string, unknown>> = [
        { type: "meta", taskName: run.task, command: "true", runId: run.runId, attempt: 1, startedAt: run.startedAt },
        ...(run.stdout ?? []).map((data) => ({ type: "stdout", ts: run.startedAt, data })),
        ...(run.stderr ?? []).map((data) => ({ type: "stderr", ts: run.startedAt, data })),
    ];

    if (run.exit) {
        lines.push({
            type: "exit",
            ts: run.startedAt,
            code: run.exit.code,
            duration_ms: run.exit.durationMs,
            ...(run.exit.timedOut ? { timedOut: true } : {}),
        });
    }

    const stamp = run.fileStamp ?? formatLocalFileTimestamp(new Date(run.startedAt));
    writeFileSync(
        join(taskDir, `${stamp}-${run.runId}.jsonl`),
        `${lines.map((l) => SafeJSON.stringify(l)).join("\n")}\n`
    );
}

const bigStdout = Array.from({ length: 300 }, (_, i) => `progress ${i} ${"x".repeat(90)}`);
const betaStderr = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`);

const runs: FixtureRun[] = [
    { task: "alpha", runId: "a1", startedAt: "2026-10-10T10:00:00.000Z", exit: { code: 0, durationMs: 1000 } },
    { task: "alpha", runId: "a2", startedAt: "2026-10-10T11:00:00.000Z", exit: { code: 0, durationMs: 2000 } },
    {
        task: "alpha",
        runId: "a3",
        startedAt: "2026-10-10T12:00:00.000Z",
        exit: { code: 1, durationMs: 3000 },
        stdout: ["hello"],
        stderr: ["boom 1", "boom 2"],
    },
    {
        task: "alpha",
        runId: "a4",
        startedAt: "2026-10-10T13:00:00.000Z",
        exit: { code: null, durationMs: 60_000, timedOut: true },
    },
    {
        task: "alpha",
        runId: "a5",
        startedAt: "2026-10-11T10:00:00.000Z",
        exit: { code: 0, durationMs: 4000 },
        stdout: bigStdout,
    },
    { task: "alpha", runId: "a6", startedAt: "2026-10-11T11:00:00.000Z", exit: { code: null, durationMs: 5000 } },
    { task: "alpha", runId: "a7", startedAt: "2026-10-11T12:00:00.000Z", stdout: ["still going"] },
    { task: "beta", runId: "b1", startedAt: "2026-10-10T09:00:00.000Z", exit: { code: 0, durationMs: 500 } },
    {
        task: "beta",
        runId: "b2",
        startedAt: "2026-10-11T09:00:00.000Z",
        exit: { code: 2, durationMs: 700 },
        stderr: betaStderr,
    },
    { task: "gamma", runId: "g1", startedAt: "2026-09-01T00:00:00.000Z", exit: { code: 0, durationMs: 100 } },
];

for (const run of runs) {
    writeRun(base, run);
}

const tasks: DaemonTask[] = [
    { name: "alpha", command: "true", every: "every 1 hour", retries: 0, enabled: true, timeoutMs: 60_000 },
    { name: "beta", command: "true", every: "every 1 day", retries: 0, enabled: false },
    { name: "delta", command: "true", every: "every 5 minutes", retries: 0, enabled: true },
];

const allWindow = resolveWindow({ since: "all", now: NOW });
const oct11 = resolveWindow({ since: "2026-10-11T00:00:00Z", until: "2026-10-11T23:59:59Z", now: NOW });

afterAll(() => rmSync(base, { recursive: true, force: true }));

function taskOf(stats: ReturnType<typeof collectDaemonStats>, name: string) {
    const task = stats.tasks.find((t) => t.task === name);

    if (!task) {
        throw new Error(`no stats for ${name}`);
    }

    return task;
}

function sum(values: number[]): number {
    return values.reduce((a, b) => a + b, 0);
}

describe("collectDaemonStats", () => {
    const stats = collectDaemonStats({ logsBaseDir: base, tasks, window: allWindow, now: NOW });

    test("counts every outcome, and the failure rate leaves the unfinished run out", () => {
        const alpha = taskOf(stats, "alpha");

        expect(alpha).toMatchObject({ runs: 7, ok: 3, failed: 1, timedOut: 1, killed: 1, unfinished: 1 });
        expect(alpha.failureRate).toBe(0.5);
        expect(stats.totals).toMatchObject({ runs: 10, ok: 5, failed: 2, timedOut: 1, killed: 1, unfinished: 1 });
    });

    test("nearest-rank percentiles over finished runs, the exit record found past a 30 KB output", () => {
        const alpha = taskOf(stats, "alpha");

        expect([alpha.p50Ms, alpha.p90Ms, alpha.p99Ms, alpha.maxMs]).toEqual([3000, 60_000, 60_000, 60_000]);
        expect(alpha.recentRuns.find((run) => run.runId === "a5")).toMatchObject({ status: "ok", durationMs: 4000 });

        const counts = Object.fromEntries(alpha.histogram.filter((b) => b.count > 0).map((b) => [b.label, b.count]));
        expect(counts).toEqual({ "1-2s": 1, "2-5s": 3, "5-10s": 1, "1-2m": 1 });
    });

    test("failures newest first with their stderr tail; the last run is the unfinished one", () => {
        const alpha = taskOf(stats, "alpha");

        expect(alpha.failures.map((run) => [run.runId, run.status, run.exitCode])).toEqual([
            ["a6", "killed", null],
            ["a4", "timedOut", null],
            ["a3", "failed", 1],
        ]);
        expect(alpha.failures[2].stderrTail).toEqual(["boom 1", "boom 2"]);
        expect(alpha.lastFailure?.runId).toBe("a6");
        expect(alpha.lastRun).toMatchObject({ runId: "a7", status: "unfinished", durationMs: null });

        const beta = taskOf(stats, "beta");
        expect(beta.failures[0].stderrTail).toEqual(betaStderr.slice(-12));
    });

    test("configured tasks without runs stay listed; a run-log folder outside the config is marked", () => {
        expect(stats.tasks.map((t) => t.task)).toEqual(["alpha", "beta", "delta", "gamma"]);
        expect(taskOf(stats, "delta")).toMatchObject({ runs: 0, failureRate: null, p50Ms: null, lastRun: null });
        expect(taskOf(stats, "gamma")).toMatchObject({ configured: false, enabled: null, runs: 1 });
        expect(taskOf(stats, "beta")).toMatchObject({ configured: true, enabled: false, every: "every 1 day" });
    });

    test("an open window starts its timeline at the first run, in days once it spans more than 48 hours", () => {
        const alpha = taskOf(stats, "alpha");

        expect(stats.since).toBeNull();
        expect(stats.bucket).toBe("day");
        expect(sum(alpha.timeline.map((b) => b.runs))).toBe(7);
        expect(sum(alpha.timeline.map((b) => b.failures))).toBe(3);
        expect(alpha.timeline.length).toBe(taskOf(stats, "gamma").timeline.length);
    });

    test("the window keeps only runs that started inside it, in hour buckets", () => {
        const day = collectDaemonStats({ logsBaseDir: base, tasks, window: oct11, now: NOW });
        const alpha = taskOf(day, "alpha");

        expect(day.tasks.map((t) => t.task)).toEqual(["alpha", "beta", "delta"]);
        expect(alpha).toMatchObject({ runs: 3, ok: 1, killed: 1, unfinished: 1, failureRate: 0.5 });
        expect(taskOf(day, "beta")).toMatchObject({ runs: 1, failed: 1 });
        expect(day.bucket).toBe("hour");
        expect(sum(alpha.timeline.map((b) => b.runs))).toBe(3);
    });

    test("a task filter and a failure limit narrow the report", () => {
        const one = collectDaemonStats({ logsBaseDir: base, tasks, window: allWindow, task: "alpha", failureLimit: 1 });

        expect(one.tasks.map((t) => t.task)).toEqual(["alpha"]);
        expect(one.tasks[0].failures.map((run) => run.runId)).toEqual(["a6"]);
        expect(one.tasks[0].killed + one.tasks[0].timedOut + one.tasks[0].failed).toBe(3);
    });

    test("a failure's stderr tail comes from the log's last 64 KB, so a noisy run is never read whole", () => {
        const dir = mkdtempSync(join(tmpdir(), "daemon-stats-tail-"));
        const noisy = Array.from({ length: 700 }, (_, i) => `noise ${i} ${"y".repeat(100)}`);

        try {
            // `writeRun` puts stdout before stderr; this run needs stderr, 70 KB of stdout, then stderr again.
            const at = "2026-10-11T08:00:00.000Z";
            mkdirSync(join(dir, "noisy"));
            const file = join(dir, "noisy", `${formatLocalFileTimestamp(new Date(at))}-n1.jsonl`);
            const records = [
                { type: "meta", taskName: "noisy", command: "true", runId: "n1", attempt: 1, startedAt: at },
                { type: "stderr", ts: at, data: "early" },
                ...noisy.map((data) => ({ type: "stdout", ts: at, data })),
                ...["late 1", "late 2"].map((data) => ({ type: "stderr", ts: at, data })),
                { type: "exit", ts: at, code: 1, duration_ms: 10 },
            ];
            writeFileSync(file, `${records.map((r) => SafeJSON.stringify(r)).join("\n")}\n`);

            const noisyStats = collectDaemonStats({ logsBaseDir: dir, tasks: [], window: oct11 });
            expect(noisyStats.tasks[0].failures[0].stderrTail).toEqual(["late 1", "late 2"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("hour buckets keep both repeated hours apart when daylight saving time ends", () => {
        const dir = mkdtempSync(join(tmpdir(), "daemon-stats-dst-"));
        const ok = { code: 0, durationMs: 10 };

        try {
            withTimeZone("America/New_York", () => {
                // 2026-11-01 in New York: 01:00 EDT is 05:00Z, the clock falls back, and 01:00 EST is 06:00Z.
                writeRun(dir, { task: "dst", runId: "d1", startedAt: "2026-11-01T05:30:00.000Z", exit: ok });
                writeRun(dir, { task: "dst", runId: "d2", startedAt: "2026-11-01T06:30:00.000Z", exit: ok });
                const window = resolveWindow({ since: "2026-11-01T04:00:00Z", until: "2026-11-01T09:00:00Z" });
                const dst = collectDaemonStats({ logsBaseDir: dir, tasks: [], window }).tasks[0];

                expect(dst.timeline.map((b) => [b.start, b.runs])).toEqual([
                    ["2026-11-01T04:00:00.000Z", 0],
                    ["2026-11-01T05:00:00.000Z", 1],
                    ["2026-11-01T06:00:00.000Z", 1],
                    ["2026-11-01T07:00:00.000Z", 0],
                    ["2026-11-01T08:00:00.000Z", 0],
                    ["2026-11-01T09:00:00.000Z", 0],
                ]);
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("only run logs whose names fall in the window are opened", () => {
        const dir = mkdtempSync(join(tmpdir(), "daemon-stats-names-"));

        try {
            writeRun(dir, {
                task: "solo",
                runId: "s1",
                startedAt: "2026-10-11T08:00:00.000Z",
                exit: { code: 0, durationMs: 10 },
                fileStamp: "2026-01-01T00-00-00",
            });

            expect(collectDaemonStats({ logsBaseDir: dir, tasks: [], window: oct11 }).tasks).toEqual([]);
            expect(collectDaemonStats({ logsBaseDir: dir, tasks: [], window: allWindow }).totals.runs).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("resolveWindow", () => {
    test("reads durations, all, ISO times and now", () => {
        expect(resolveWindow({ since: "24h", now: NOW })).toEqual({
            since: new Date("2026-10-11T00:00:00.000Z"),
            until: NOW,
        });
        expect(resolveWindow({ since: "7d", until: "now", now: NOW }).since).toEqual(
            new Date("2026-10-05T00:00:00.000Z")
        );
        expect(allWindow.since).toBeNull();
    });

    test("refuses an unreadable edge and an empty window", () => {
        expect(() => resolveWindow({ since: "yesterday-ish", now: NOW })).toThrow("--since");
        expect(() => resolveWindow({ since: "1h", until: "2h", now: NOW })).toThrow("empty");
    });
});

describe("readRunOutput", () => {
    test("finds a run by id and returns its output with its outcome", () => {
        const output = readRunOutput({ logsBaseDir: base, runId: "a3" });

        expect(output?.run).toMatchObject({ task: "alpha", status: "failed", exitCode: 1, durationMs: 3000 });
        expect(output?.lines.map((line) => [line.type, line.data])).toEqual([
            ["stdout", "hello"],
            ["stderr", "boom 1"],
            ["stderr", "boom 2"],
        ]);
        expect(readRunOutput({ logsBaseDir: base, runId: "nope" })).toBeNull();
    });
});

describe("readStderrTail", () => {
    test("a run log the daemon pruned after it was listed reads as no stderr, not a failed report", () => {
        expect(readStderrTail(join(base, "alpha", "pruned-a moment ago.jsonl"))).toEqual([]);
    });
});

describe("summarizeHealthLines", () => {
    const window = resolveWindow({ since: "24h", now: NOW });
    const record = (time: string, msg: string, extra: Record<string, unknown> = {}) =>
        SafeJSON.stringify({ level: 40, time, msg, ...extra });

    test("counts the daemon's health lines inside the window, newest first", () => {
        const lines = [
            record("2026-10-11T05:00:00.000Z", "[daemon] scheduler wedged (no tick within threshold)", {
                silentMs: 300_000,
            }),
            record("2026-10-11T06:00:00.000Z", "[daemon] watchdog sampled late (process suspended)", {
                suspendedMs: 600_000,
            }),
            record("2026-10-11T07:00:00.000Z", "[daemon] task timed out, sending SIGTERM", { task: "alpha" }),
            record("2026-10-09T07:00:00.000Z", "[daemon] task timed out, sending SIGTERM", { task: "alpha" }),
            record("2026-10-11T07:00:01.000Z", "[daemon] task process timed out", { task: "alpha" }),
            "not json [daemon] scheduler wedged",
        ];
        const health = summarizeHealthLines({ lines, window, files: ["day.log"] });

        expect(health).toMatchObject({ wedged: 1, sampledLate: 1, taskTimedOut: 1, error: null, files: ["day.log"] });
        expect(health.events.map((e) => [e.kind, e.task, e.gapMs])).toEqual([
            ["taskTimedOut", "alpha", null],
            ["sampledLate", null, 600_000],
            ["wedged", null, 300_000],
        ]);
    });

    test.skipIf(!ripgrepBinary())("reads a compressed day log (`.log.zst`) beside a plain one", async () => {
        const logs = genesisToolsDir("logs");
        mkdirSync(logs, { recursive: true });
        const plain = join(logs, "2026-10-10.log");
        const older = join(logs, "2026-10-09.log");
        writeFileSync(
            plain,
            `${record("2026-10-10T07:00:00.000Z", "[daemon] task timed out, sending SIGTERM", { task: "a" })}\n`
        );
        writeFileSync(older, `${record("2026-10-09T07:00:00.000Z", "[daemon] scheduler wedged", { silentMs: 1 })}\n`);
        await compressFile({ source: older });
        rmSync(older);

        try {
            const health = await readDaemonHealth(
                resolveWindow({ since: "2026-10-09", until: "2026-10-10T23:00:00", now: NOW })
            );
            expect(health).toMatchObject({ wedged: 1, taskTimedOut: 1, error: null });
            expect(health.files).toEqual([`${older}.zst`, plain]);
        } finally {
            rmSync(plain, { force: true });
            rmSync(`${older}.zst`, { force: true });
        }
    });

    test("a burst of newer timeouts does not push an older wedge out of the event list", () => {
        const timeouts = Array.from({ length: 60 }, (_, i) =>
            record(new Date(Date.parse("2026-10-11T12:00:00.000Z") + i * 1000).toISOString(), "[daemon] task timed out")
        );
        const wedge = record("2026-10-11T01:00:00.000Z", "[daemon] scheduler wedged", { silentMs: 1 });
        const health = summarizeHealthLines({ lines: [wedge, ...timeouts], window, files: [] });

        expect(health.taskTimedOut).toBe(60);
        expect(health.events.filter((e) => e.kind === "taskTimedOut")).toHaveLength(50);
        expect(health.events.at(-1)?.kind).toBe("wedged");
    });
});

describe("timelineStarts", () => {
    /** The walk timelineStarts did before it was bounded: every bucket of the window, then the last 400. */
    function everyBucketThenLast400(window: StatsWindow, firstRunMs: number | null) {
        const startMs = window.since?.getTime() ?? firstRunMs ?? window.until.getTime();
        const unit: TimelineUnit = window.until.getTime() - startMs <= 48 * 3_600_000 ? "hour" : "day";
        const cursor = new Date(startMs);
        cursor.setMinutes(0, 0, 0);

        if (unit === "day") {
            cursor.setHours(0);
        }

        const starts: number[] = [];

        while (cursor.getTime() <= window.until.getTime()) {
            starts.push(cursor.getTime());

            if (unit === "hour") {
                cursor.setTime(cursor.getTime() + 3_600_000);
            } else {
                cursor.setDate(cursor.getDate() + 1);
            }
        }

        return { unit, starts: starts.slice(-400) };
    }

    test("gives the same buckets as walking the whole window, for long, short and DST-crossing windows", () => {
        const until = new Date("2026-10-26T12:34:56.000Z");
        const daysBefore = (days: number) => new Date(until.getTime() - days * 86_400_000);
        const cases: Array<{ window: StatsWindow; firstRunMs: number | null }> = [
            { window: { since: daysBefore(3 * 365), until }, firstRunMs: null },
            { window: { since: daysBefore(400), until }, firstRunMs: null },
            { window: { since: daysBefore(30), until }, firstRunMs: null },
            { window: { since: null, until }, firstRunMs: daysBefore(5 * 365).getTime() },
            { window: { since: null, until }, firstRunMs: null },
            { window: { since: new Date(until.getTime() - 47 * 3_600_000), until }, firstRunMs: null },
        ];

        for (const zone of ["Europe/Prague", "America/New_York", "Asia/Kolkata"]) {
            withTimeZone(zone, () => {
                for (const { window, firstRunMs } of cases) {
                    expect({ zone, ...timelineStarts(window, firstRunMs) }).toEqual({
                        zone,
                        ...everyBucketThenLast400(window, firstRunMs),
                    });
                }
            });
        }
    });
});
