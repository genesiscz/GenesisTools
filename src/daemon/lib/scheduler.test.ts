import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonTask, RunResult, TaskState } from "./types";

const logsBaseDir = mkdtempSync(join(tmpdir(), "scheduler-test-"));

// No-op notifier: bun test must NEVER fire real macOS notification banners
// (they spammed the user's notification center before this seam existed).
const noopNotify = async () => true;

let runDurationMs = 1;

const runTaskMock = mock(async () => {
    if (runDurationMs > 1) {
        await Bun.sleep(runDurationMs);
    }

    return {
        exitCode: 0,
        duration_ms: runDurationMs,
        logFile: "/tmp/test.jsonl",
    };
});

import { planAfterRun, planDueRun } from "./missed-run";
import { dispatchDueTasks, EXIT_OWNERSHIP_LOST, EXIT_WEDGED, jitteredNow, runSchedulerLoop } from "./scheduler";
import { parseSystemCapabilities } from "./wake";

async function drainActiveRuns(activeRuns: Set<string>): Promise<void> {
    const deadline = Date.now() + 5_000;

    while (activeRuns.size > 0 && Date.now() < deadline) {
        await Bun.sleep(10);
    }
}

describe("scheduler heartbeat", () => {
    test("the per-iteration sleep log reaches the file-backed appLogger, not just a logToFile:false local logger", async () => {
        const { daemonLog: log, logSchedulerHeartbeat } = await import("./scheduler");
        const debugSpy = mock(() => {});
        const original = log.debug;
        log.debug = debugSpy;

        try {
            logSchedulerHeartbeat(60_000, 0);

            expect(debugSpy).toHaveBeenCalled();
        } finally {
            log.debug = original;
        }
    });
});

describe("scheduler loop-failure logging", () => {
    test("the catch block logs a timestamp and a consecutive-failure count", async () => {
        const { daemonLog: log, logSchedulerLoopFailure } = await import("./scheduler");
        const errorSpy = mock(() => {});
        const original = log.error;
        log.error = errorSpy;

        try {
            logSchedulerLoopFailure(new Error("boom"), 1);
            logSchedulerLoopFailure(new Error("boom again"), 2);

            expect(errorSpy).toHaveBeenCalledTimes(2);
            const calls = errorSpy.mock.calls as unknown[][];
            const secondBindings = calls[1]?.[0];

            if (!secondBindings || typeof secondBindings !== "object") {
                throw new Error("expected bindings object on second error log call");
            }

            const secondCallArgs = secondBindings as Record<string, unknown>;
            expect(secondCallArgs.consecutiveFailures).toBe(2);
            expect(secondCallArgs.timestamp).toBeDefined();
        } finally {
            log.error = original;
        }
    });
});

describe("scheduler logging consolidation", () => {
    test("a task-completion event logs exactly once via appLogger, not twice via two loggers", async () => {
        const { daemonLog: log } = await import("./scheduler");
        const infoSpy = mock(() => {});
        const original = log.info;
        log.info = infoSpy;

        const taskStates = new Map<string, TaskState>();
        const activeRuns = new Set<string>();
        const now = new Date();
        const tasks: DaemonTask[] = [
            {
                name: "once-task",
                command: "echo hi",
                every: "every 1 hour",
                retries: 0,
                enabled: true,
            },
        ];

        taskStates.set("once-task", {
            nextRunAt: new Date(now.getTime() - 1_000),
            attemptCount: 0,
            running: false,
        });

        try {
            dispatchDueTasks({
                tasks,
                taskStates,
                activeRuns,
                logsBaseDir,
                now,
                notify: noopNotify,
                runTask: runTaskMock,
            });
            await drainActiveRuns(activeRuns);

            const completionLogs = (infoSpy.mock.calls as unknown[][]).filter((call) => {
                const message = call[1];
                return typeof message === "string" && message.includes("task completed");
            });

            expect(completionLogs).toHaveLength(1);
        } finally {
            log.info = original;
        }
    });
});

describe("thundering herd prevention", () => {
    test("multiple tasks overdue after a simulated wall-clock jump get staggered dispatch times, not identical ones", () => {
        const taskNames = ["task-a", "task-b", "task-c", "task-d", "task-e"];
        const nextRunAts = taskNames.map((name) => jitteredNow(name).getTime());
        const unique = new Set(nextRunAts);

        expect(unique.size).toBe(taskNames.length);

        for (const ts of nextRunAts) {
            expect(ts - Date.now()).toBeGreaterThanOrEqual(0);
            expect(ts - Date.now()).toBeLessThanOrEqual(2000);
        }
    });
});

describe("scheduler grid anchoring", () => {
    afterEach(() => {
        runTaskMock.mockClear();
        runDurationMs = 1;
    });

    test("a slow task run does not permanently shift the schedule's cadence", async () => {
        const taskStates = new Map<string, TaskState>();
        const activeRuns = new Set<string>();
        const hourMs = 3_600_000;
        const scheduledAt = new Date(Date.now() - 100);
        const tasks: DaemonTask[] = [
            {
                name: "slow-task",
                command: "echo hi",
                every: "every 1 hour",
                retries: 0,
                enabled: true,
            },
        ];

        taskStates.set("slow-task", {
            nextRunAt: scheduledAt,
            attemptCount: 0,
            running: false,
        });

        runDurationMs = 50;
        dispatchDueTasks({
            tasks,
            taskStates,
            activeRuns,
            logsBaseDir,
            now: scheduledAt,
            notify: noopNotify,
            runTask: runTaskMock,
        });
        await drainActiveRuns(activeRuns);

        const afterSlowRun = taskStates.get("slow-task");
        const expectedFirstNext = scheduledAt.getTime() + hourMs;
        expect(afterSlowRun?.nextRunAt.getTime()).toBe(expectedFirstNext);

        runDurationMs = 1;
        runTaskMock.mockClear();
        dispatchDueTasks({
            tasks,
            taskStates,
            activeRuns,
            logsBaseDir,
            now: afterSlowRun?.nextRunAt,
            notify: noopNotify,
            runTask: runTaskMock,
        });
        await drainActiveRuns(activeRuns);

        expect(runTaskMock).toHaveBeenCalledTimes(1);
        expect(taskStates.get("slow-task")?.nextRunAt.getTime()).toBe(expectedFirstNext + hourMs);
    });
});

describe("scheduler task .finally() resilience", () => {
    afterEach(() => {
        runTaskMock.mockClear();
        runDurationMs = 1;
    });

    test("a task with a malformed `every` field does not re-execute every tick forever", async () => {
        const taskStates = new Map<string, TaskState>();
        const activeRuns = new Set<string>();
        const now = new Date("2026-06-30T12:00:00.000Z");
        const tasks: DaemonTask[] = [
            {
                name: "bad-interval",
                command: "echo hi",
                every: "not-a-valid-interval",
                retries: 0,
                enabled: true,
            },
        ];

        taskStates.set("bad-interval", {
            nextRunAt: new Date(now.getTime() - 1_000),
            attemptCount: 0,
            running: false,
        });

        dispatchDueTasks({ tasks, taskStates, activeRuns, logsBaseDir, now, notify: noopNotify, runTask: runTaskMock });
        await drainActiveRuns(activeRuns);

        expect(runTaskMock).toHaveBeenCalledTimes(1);

        const state = taskStates.get("bad-interval");
        expect(state?.nextRunAt.getTime()).toBeGreaterThan(now.getTime() + 59_000);

        runTaskMock.mockClear();
        dispatchDueTasks({ tasks, taskStates, activeRuns, logsBaseDir, now, notify: noopNotify, runTask: runTaskMock });
        await drainActiveRuns(activeRuns);

        expect(runTaskMock).toHaveBeenCalledTimes(0);
    });
});

describe("runSchedulerLoop resilience (Jul 3/6 incident class)", () => {
    test("per-tick ownership check: a usurped daemon self-terminates instead of running as a zombie", async () => {
        const codes: number[] = [];

        await runSchedulerLoop(logsBaseDir, {
            verifyOwnership: () => false,
            loadConfig: async () => ({ tasks: [] }),
            exit: (code) => {
                codes.push(code);
            },
            notify: noopNotify,
        });

        expect(codes).toEqual([EXIT_OWNERSHIP_LOST]);
    });

    test("wedge watchdog exits with EXIT_WEDGED when the loop goes silent past the threshold", async () => {
        const codes: number[] = [];

        await runSchedulerLoop(logsBaseDir, {
            verifyOwnership: () => true,
            watchdogIntervalMs: 25,
            wedgeThresholdMs: 80,
            // An empty task list makes getNextWakeupMs return 60 s, and wakefulSleep only
            // re-reads shouldAbort between ticks, so the SIGINT below cost a full 2 s tick.
            wakefulTickMs: 20,
            loadConfig: async () => ({ tasks: [] }),
            exit: (code) => {
                codes.push(code);
                // Unwind the (deliberately silent) loop so the test completes.
                process.emit("SIGINT");
            },
            notify: noopNotify,
        });

        expect(codes[0]).toBe(EXIT_WEDGED);
    });

    // 2026-10-06 15:30, 20:03 and 2026-10-11 21:32 (UTC): each "wedged" exit fired in the first seconds of a
    // macOS DarkWake, after 8 to 14 minutes of Maintenance Sleep (pmset log). The loop was not hung; the
    // watchdog woke first and counted the sleep as silence. These tests suspend the whole process the same
    // way: the wall clock jumps while the loop is parked in an await and the watchdog sees the jump late.
    function suspendableClock(): { suspend: (ms: number) => void; restore: () => void } {
        const realNow = Date.now.bind(Date);
        let suspendedMs = 0;
        const clock = spyOn(Date, "now").mockImplementation(() => realNow() + suspendedMs);

        return {
            suspend: (ms) => {
                suspendedMs += ms;
            },
            restore: () => clock.mockRestore(),
        };
    }

    function parkedConfig(): { load: () => Promise<{ tasks: DaemonTask[] }>; release: () => void } {
        const { promise, resolve } = Promise.withResolvers<{ tasks: DaemonTask[] }>();

        return { load: () => promise, release: () => resolve({ tasks: [] }) };
    }

    test("a system sleep is not a wedge: time the whole process was suspended is not scheduler silence", async () => {
        const codes: number[] = [];
        const clock = suspendableClock();
        const config = parkedConfig();

        try {
            const loop = runSchedulerLoop(logsBaseDir, {
                verifyOwnership: () => true,
                watchdogIntervalMs: 25,
                wedgeThresholdMs: 5_000,
                wakefulTickMs: 20,
                loadConfig: config.load,
                exit: (code) => {
                    codes.push(code);
                },
                notify: noopNotify,
            });

            await Bun.sleep(60);
            clock.suspend(10 * 60_000);
            await Bun.sleep(80);

            process.emit("SIGINT");
            config.release();
            await loop;
        } finally {
            clock.restore();
        }

        expect(codes).toEqual([]);
    });

    test("after a suspension the watchdog still trips on real silence and reports only the awake part", async () => {
        const codes: number[] = [];
        const silences: number[] = [];
        const clock = suspendableClock();
        const config = parkedConfig();
        const { daemonLog } = await import("./scheduler");
        const errorSpy = spyOn(daemonLog, "error").mockImplementation((fields: unknown) => {
            if (typeof fields === "object" && fields !== null && "silentMs" in fields) {
                silences.push(Number(fields.silentMs));
            }
        });
        const { promise: tripped, resolve: onTrip } = Promise.withResolvers<void>();

        try {
            const loop = runSchedulerLoop(logsBaseDir, {
                verifyOwnership: () => true,
                watchdogIntervalMs: 25,
                wedgeThresholdMs: 150,
                wakefulTickMs: 20,
                loadConfig: config.load,
                exit: (code) => {
                    codes.push(code);
                    onTrip();
                },
                notify: noopNotify,
            });

            await Bun.sleep(40);
            clock.suspend(10 * 60_000);
            await tripped;

            process.emit("SIGINT");
            config.release();
            await loop;
        } finally {
            errorSpy.mockRestore();
            clock.restore();
        }

        expect(codes[0]).toBe(EXIT_WEDGED);
        expect(silences[0]).toBeGreaterThan(150);
        expect(silences[0]).toBeLessThan(60_000);
    });

    test("a second shutdown signal force-exits immediately (no more unkillable daemons)", async () => {
        const codes: number[] = [];

        const loop = runSchedulerLoop(logsBaseDir, {
            verifyOwnership: () => true,
            wakefulTickMs: 20,
            loadConfig: async () => ({ tasks: [] }),
            exit: (code) => {
                codes.push(code);
            },
            notify: noopNotify,
        });

        await Bun.sleep(20); // let the loop install its signal handlers
        process.emit("SIGINT"); // graceful: flips running=false, arms grace timer
        process.emit("SIGINT"); // impatient: must exit immediately
        await loop;

        expect(codes).toEqual([1]);
    });
});

describe('notify: "failure"', () => {
    async function messagesFor(exitCode: number, notifyMode: DaemonTask["notify"]): Promise<string[]> {
        const messages: string[] = [];
        const now = new Date();
        const taskStates = new Map<string, TaskState>([
            ["quiet", { nextRunAt: new Date(now.getTime() - 1_000), attemptCount: 0, running: false }],
        ]);
        const activeRuns = new Set<string>();
        const tasks: DaemonTask[] = [
            {
                name: "quiet",
                command: "true",
                every: "every 15 minutes",
                retries: 0,
                enabled: true,
                notify: notifyMode,
            },
        ];

        dispatchDueTasks({
            tasks,
            taskStates,
            activeRuns,
            logsBaseDir,
            now,
            notify: async (options) => {
                messages.push(options.message);
                return true;
            },
            runTask: async () => ({ exitCode, duration_ms: 1, logFile: "/tmp/test.jsonl" }),
        });
        await drainActiveRuns(activeRuns);
        return messages;
    }

    test("a successful run sends no banner", async () => {
        expect(await messagesFor(0, "failure")).toEqual([]);
    });

    test("a failed run still sends the failure banner", async () => {
        expect(await messagesFor(1, "failure")).toEqual(["Failed after 1 attempt, retries exhausted"]);
    });

    test("the default still sends start and completion", async () => {
        expect(await messagesFor(0, undefined)).toEqual(["Task started", "Completed in 1ms"]);
    });
});

describe("a task that keeps failing", () => {
    // Observed 2026-10-05: `services-idle-reap` failed on 38 of 79 runs in one day, every 15 minutes, and
    // each failure put the same banner on screen. One banner per streak says it; the rest is noise.
    const HOUR = 3_600_000;

    /** Runs the task once per entry of `outcomes`, `gapMs` apart, on ONE task state, and returns the banners. */
    async function bannersFor(outcomes: number[], gapMs: number, retries = 0): Promise<string[]> {
        const messages: string[] = [];
        const start = new Date("2026-10-05T10:00:00Z");
        const state: TaskState = { nextRunAt: start, attemptCount: 0, running: false };
        const taskStates = new Map<string, TaskState>([["flaky", state]]);
        const activeRuns = new Set<string>();
        const tasks: DaemonTask[] = [
            { name: "flaky", command: "true", every: "every 15 minutes", retries, enabled: true, notify: "failure" },
        ];

        for (const [index, exitCode] of outcomes.entries()) {
            const now = new Date(start.getTime() + index * gapMs);

            state.nextRunAt = new Date(now.getTime() - 1_000);
            dispatchDueTasks({
                tasks,
                taskStates,
                activeRuns,
                logsBaseDir,
                now,
                notify: async (options) => {
                    messages.push(options.message);
                    return true;
                },
                runTask: async () => ({ exitCode, duration_ms: 1, logFile: "/tmp/test.jsonl" }),
            });
            await drainActiveRuns(activeRuns);
        }

        return messages;
    }

    test("three failures in a row put up one banner", async () => {
        expect(await bannersFor([1, 1, 1], 15 * 60_000)).toEqual(["Failed after 1 attempt, retries exhausted"]);
    });

    test("a run that exhausts its retries counts once in the streak", async () => {
        // The retry backoff is a real sleep; the streak logic does not depend on its length.
        const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
        try {
            expect(await bannersFor([1, 1, 1], 15 * 60_000, 2)).toEqual(["Failed after 3 attempts, retries exhausted"]);
            expect(await bannersFor([1, 1, 1], 4 * HOUR, 2)).toEqual([
                "Failed after 3 attempts, retries exhausted",
                "Still failing: 3 runs in a row, retries exhausted",
            ]);
        } finally {
            sleep.mockRestore();
        }
    });

    test("a success ends the streak, so the next failure is a new banner", async () => {
        expect(await bannersFor([1, 0, 1], 15 * 60_000)).toEqual([
            "Failed after 1 attempt, retries exhausted",
            "Failed after 1 attempt, retries exhausted",
        ]);
    });

    test("a streak that lasts past the reminder interval says how long it has run", async () => {
        const messages = await bannersFor([1, 1, 1], 4 * HOUR);

        expect(messages).toEqual([
            "Failed after 1 attempt, retries exhausted",
            "Still failing: 3 runs in a row, retries exhausted",
        ]);
    });
});

describe("task isolation", () => {
    async function settle(activeRuns: Set<string>, name: string): Promise<void> {
        const deadline = Date.now() + 5_000;

        while (activeRuns.has(name) && Date.now() < deadline) {
            await Bun.sleep(5);
        }
    }

    test("due tasks run side by side: a hung, then failing task neither delays nor fails another", async () => {
        const taskStates = new Map<string, TaskState>();
        const activeRuns = new Set<string>();
        const now = new Date("2026-06-30T12:00:00.000Z");
        const tasks: DaemonTask[] = [
            { name: "hung", command: "sleep 600", every: "every 1 minute", retries: 0, enabled: true },
            { name: "quick", command: "true", every: "every 1 minute", retries: 0, enabled: true },
        ];

        for (const task of tasks) {
            taskStates.set(task.name, { nextRunAt: new Date(now.getTime() - 1_000), attemptCount: 0, running: false });
        }

        const { promise: hungResult, resolve: finishHung } = Promise.withResolvers<RunResult>();
        const started: string[] = [];
        const runTask = async (task: DaemonTask): Promise<RunResult> => {
            started.push(task.name);
            return task.name === "hung" ? hungResult : { exitCode: 0, duration_ms: 1, logFile: "/tmp/quick.jsonl" };
        };

        dispatchDueTasks({ tasks, taskStates, activeRuns, logsBaseDir, now, notify: noopNotify, runTask });
        await settle(activeRuns, "quick");

        expect(started).toEqual(["hung", "quick"]);
        expect(activeRuns.has("hung")).toBe(true);

        // A minute later the quick task is due again while the hung one has still not returned.
        const later = new Date(Date.now() + 120_000);
        dispatchDueTasks({ tasks, taskStates, activeRuns, logsBaseDir, now: later, notify: noopNotify, runTask });
        await settle(activeRuns, "quick");

        expect(started).toEqual(["hung", "quick", "quick"]);

        finishHung({ exitCode: 1, duration_ms: 600_000, logFile: "/tmp/hung.jsonl" });
        await drainActiveRuns(activeRuns);
        dispatchDueTasks({
            tasks,
            taskStates,
            activeRuns,
            logsBaseDir,
            now: new Date(Date.now() + 240_000),
            notify: noopNotify,
            runTask,
        });
        await drainActiveRuns(activeRuns);

        expect(started.filter((name) => name === "quick")).toHaveLength(3);
    });
});

describe("missed time-of-day runs", () => {
    // A fixed local day: the 03:00 slot of 2026-10-12, the Mac asleep until 08:30.
    const at = (hhmm: string, day = 12) => {
        const [h, m] = hhmm.split(":").map(Number);
        return new Date(2026, 9, day, h ?? 0, m ?? 0, 0, 0);
    };
    const nightly = (missedRun?: DaemonTask["missedRun"], priority?: DaemonTask["priority"]): DaemonTask => ({
        name: "nightly",
        command: "true",
        every: "every day at 03:00",
        retries: 0,
        enabled: true,
        missedRun,
        priority,
    });
    const asleepSince3 = (): TaskState => ({ nextRunAt: at("03:00"), attemptCount: 0, running: false });

    test("on time it runs as scheduled, whatever the policy", () => {
        const plan = planDueRun({
            task: nightly({ mode: "skip" }),
            state: asleepSince3(),
            now: at("03:01"),
            fullWake: false,
        });
        expect(plan).toMatchObject({ action: "run", reason: "scheduled", priority: "normal" });
    });

    test("asap (the default) catches up at the first tick after the wake", () => {
        const plan = planDueRun({ task: nightly(), state: asleepSince3(), now: at("08:30"), fullWake: false });
        expect(plan).toMatchObject({ action: "run", reason: "catch-up", priority: "normal" });
    });

    test("skip waits for the next regular slot", () => {
        const plan = planDueRun({
            task: nightly({ mode: "skip" }),
            state: asleepSince3(),
            now: at("08:30"),
            fullWake: true,
        });
        expect(plan).toEqual({ action: "skip", next: at("03:00", 13), why: expect.any(String) });
    });

    test("on-wake does not start in a DarkWake, and runs at low priority at the first full wake", () => {
        const task = nightly({ mode: "on-wake" }, "high");
        const dark = planDueRun({ task, state: asleepSince3(), now: at("04:10"), fullWake: false });
        expect(dark).toMatchObject({
            action: "defer",
            reason: "catch-up",
            until: new Date(at("04:10").getTime() + 60_000),
        });

        const waiting: TaskState = {
            ...asleepSince3(),
            nextRunAt: at("04:11"),
            reason: "catch-up",
            slotAt: at("03:00"),
        };
        expect(planDueRun({ task, state: waiting, now: at("04:11"), fullWake: false }).action).toBe("defer");
        expect(planDueRun({ task, state: waiting, now: at("08:30"), fullWake: true })).toMatchObject({
            action: "run",
            reason: "catch-up",
            priority: "low",
            scheduledFor: at("03:00"),
        });
    });

    test("retry-at runs at 10:00, retries at 12:00 after a failure, then waits for the next night", () => {
        const task = nightly({ mode: "retry-at", times: ["10:00", "12:00"] });
        const missed = planDueRun({ task, state: asleepSince3(), now: at("08:30"), fullWake: true });
        expect(missed).toMatchObject({
            action: "defer",
            until: at("10:00"),
            reason: "catch-up",
            retryQueue: [at("12:00").getTime()],
        });

        const state: TaskState = {
            nextRunAt: at("10:00"),
            attemptCount: 0,
            running: false,
            reason: "catch-up",
            slotAt: at("03:00"),
            retryQueue: [at("12:00").getTime()],
        };
        expect(planDueRun({ task, state, now: at("10:00"), fullWake: true })).toMatchObject({
            action: "run",
            reason: "catch-up",
        });

        const afterFailure = planAfterRun({ task, state, ok: false, now: at("10:02") });
        expect(afterFailure).toEqual({ nextRunAt: at("12:00"), reason: "retry", slotAt: at("03:00"), retryQueue: [] });

        const retrying: TaskState = { ...state, ...afterFailure };
        expect(planDueRun({ task, state: retrying, now: at("12:00"), fullWake: true })).toMatchObject({
            action: "run",
            reason: "retry",
            scheduledFor: at("03:00"),
        });
        expect(planAfterRun({ task, state: retrying, ok: false, now: at("12:01") })).toEqual({
            nextRunAt: at("03:00", 13),
            reason: "scheduled",
            slotAt: at("03:00", 13),
        });
        expect(planAfterRun({ task, state, ok: true, now: at("10:02") }).nextRunAt).toEqual(at("03:00", 13));
    });

    test("retry-at runs at once when every retry time of the day has passed", () => {
        const task = nightly({ mode: "retry-at", times: ["10:00", "12:00"] });
        expect(planDueRun({ task, state: asleepSince3(), now: at("13:00"), fullWake: true })).toMatchObject({
            action: "run",
            reason: "catch-up",
        });
    });

    test("an interval task is never a catch-up", () => {
        const task: DaemonTask = { ...nightly({ mode: "skip" }), every: "every 15 minutes" };
        expect(planDueRun({ task, state: asleepSince3(), now: at("08:30"), fullWake: false })).toMatchObject({
            action: "run",
            reason: "scheduled",
        });
    });

    test("the full-wake check reads the graphics capability of IOPMrootDomain", () => {
        expect(parseSystemCapabilities('    "System Capabilities" = 15\n')).toBe(15);
        expect(parseSystemCapabilities('    "System Capabilities" = 9\n')).toBe(9);
        expect(parseSystemCapabilities("no such key")).toBeNull();
    });
});

describe("dispatch with priorities and missed runs", () => {
    function capture() {
        const started: Array<{ name: string; context: unknown }> = [];
        const run = mock(async (task: DaemonTask, _attempt: number, _logs: string, context?: unknown) => {
            started.push({ name: task.name, context });
            return { exitCode: 0, duration_ms: 1, logFile: "/tmp/test.jsonl" } satisfies RunResult;
        });
        return { started, run };
    }

    test("tasks due together start high, then normal, then low", async () => {
        const { started, run } = capture();
        const now = new Date();
        const task = (name: string, priority?: DaemonTask["priority"]): DaemonTask => ({
            name,
            command: "true",
            every: "every 5 minutes",
            retries: 0,
            enabled: true,
            notify: false,
            priority,
        });
        const tasks = [task("bulk", "low"), task("plain"), task("urgent", "high")];
        const taskStates = new Map(tasks.map((t) => [t.name, { nextRunAt: now, attemptCount: 0, running: false }]));
        const activeRuns = new Set<string>();

        dispatchDueTasks({ tasks, taskStates, activeRuns, logsBaseDir, now, notify: noopNotify, runTask: run });
        await drainActiveRuns(activeRuns);

        expect(started.map((s) => s.name)).toEqual(["urgent", "plain", "bulk"]);
        expect(started.map((s) => (s.context as { priority: string }).priority)).toEqual(["high", "normal", "low"]);
    });

    test("a DarkWake does not start an on-wake catch-up; the first full wake runs it at low priority as a catch-up", async () => {
        const { started, run } = capture();
        const slot = new Date(Date.now() - 5 * 3_600_000);
        const task: DaemonTask = {
            name: "nightly",
            command: "true",
            every: `every day at ${String(slot.getHours()).padStart(2, "0")}:${String(slot.getMinutes()).padStart(2, "0")}`,
            retries: 0,
            enabled: true,
            notify: false,
            missedRun: { mode: "on-wake" },
        };
        const state: TaskState = { nextRunAt: new Date(slot.setSeconds(0, 0)), attemptCount: 0, running: false };
        const taskStates = new Map([[task.name, state]]);
        const activeRuns = new Set<string>();
        const now = new Date();

        dispatchDueTasks({
            tasks: [task],
            taskStates,
            activeRuns,
            logsBaseDir,
            now,
            notify: noopNotify,
            runTask: run,
            fullWake: false,
        });
        expect(started).toHaveLength(0);
        expect(state.reason).toBe("catch-up");

        const later = new Date(state.nextRunAt.getTime());
        dispatchDueTasks({
            tasks: [task],
            taskStates,
            activeRuns,
            logsBaseDir,
            now: later,
            notify: noopNotify,
            runTask: run,
            fullWake: true,
        });
        await drainActiveRuns(activeRuns);

        expect(started).toHaveLength(1);
        expect(started[0]?.context).toMatchObject({ reason: "catch-up", priority: "low" });
        // After the catch-up the task waits for its next regular slot, tomorrow.
        expect(state.reason).toBeUndefined();
        expect(state.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    });
});
