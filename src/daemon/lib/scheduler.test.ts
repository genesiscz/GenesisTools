import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonTask, TaskState } from "./types";

const logsBaseDir = mkdtempSync(join(tmpdir(), "scheduler-test-"));

// No-op notifier: bun test must NEVER fire real macOS notification banners
// (they spammed the user's notification center before this seam existed).
const noopNotify = async () => {};

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

import { dispatchDueTasks, EXIT_OWNERSHIP_LOST, EXIT_WEDGED, jitteredNow, runSchedulerLoop } from "./scheduler";

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

    test("a second shutdown signal force-exits immediately (no more unkillable daemons)", async () => {
        const codes: number[] = [];

        const loop = runSchedulerLoop(logsBaseDir, {
            verifyOwnership: () => true,
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
