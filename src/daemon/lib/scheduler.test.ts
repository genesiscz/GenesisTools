import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonTask, TaskState } from "./types";

const logsBaseDir = mkdtempSync(join(tmpdir(), "scheduler-test-"));

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

mock.module("./runner", () => ({
    runTask: runTaskMock,
}));

const { dispatchDueTasks } = await import("./scheduler");

async function drainActiveRuns(activeRuns: Set<string>): Promise<void> {
    const deadline = Date.now() + 5_000;

    while (activeRuns.size > 0 && Date.now() < deadline) {
        await Bun.sleep(10);
    }
}

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
        dispatchDueTasks(tasks, taskStates, activeRuns, logsBaseDir, scheduledAt);
        await drainActiveRuns(activeRuns);

        const afterSlowRun = taskStates.get("slow-task");
        const expectedFirstNext = scheduledAt.getTime() + hourMs;
        expect(afterSlowRun?.nextRunAt.getTime()).toBe(expectedFirstNext);

        runDurationMs = 1;
        runTaskMock.mockClear();
        dispatchDueTasks(tasks, taskStates, activeRuns, logsBaseDir, afterSlowRun?.nextRunAt);
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

        dispatchDueTasks(tasks, taskStates, activeRuns, logsBaseDir, now);
        await drainActiveRuns(activeRuns);

        expect(runTaskMock).toHaveBeenCalledTimes(1);

        const state = taskStates.get("bad-interval");
        expect(state?.nextRunAt.getTime()).toBeGreaterThan(now.getTime() + 59_000);

        runTaskMock.mockClear();
        dispatchDueTasks(tasks, taskStates, activeRuns, logsBaseDir, now);
        await drainActiveRuns(activeRuns);

        expect(runTaskMock).toHaveBeenCalledTimes(0);
    });
});
