import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonTask, TaskState } from "./types";

const logsBaseDir = mkdtempSync(join(tmpdir(), "scheduler-test-"));

const runTaskMock = mock(async () => ({
    exitCode: 0,
    duration_ms: 1,
    logFile: "/tmp/test.jsonl",
}));

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

describe("scheduler task .finally() resilience", () => {
    afterEach(() => {
        runTaskMock.mockClear();
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
