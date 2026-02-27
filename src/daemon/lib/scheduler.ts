import { createLogger } from "@app/logger";
import { sendNotification } from "@app/utils/macos/notifications";
import { loadConfig } from "./config";
import { computeNextRunAt, parseInterval } from "./interval";
import { listRunsForTask } from "./log-reader";
import { runTask } from "./runner";
import type { DaemonTask, TaskState } from "./types";

const log = createLogger({ logToFile: false });

export async function runSchedulerLoop(logsBaseDir: string): Promise<void> {
    let running = true;
    const activeRuns = new Set<string>();
    const taskStates = new Map<string, TaskState>();

    const shutdown = () => {
        running = false;
    };

    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    log.info("Daemon scheduler started");

    await initializeTaskStates(taskStates, logsBaseDir);

    while (running) {
        const config = await loadConfig();
        const now = new Date();

        syncTaskStates(taskStates, config.tasks);

        for (const task of config.tasks) {
            if (!task.enabled) {
                continue;
            }

            if (activeRuns.has(task.name)) {
                continue;
            }

            const state = taskStates.get(task.name);

            if (!state || now < state.nextRunAt) {
                continue;
            }

            activeRuns.add(task.name);
            state.running = true;

            executeTask(task, logsBaseDir)
                .catch((err) => log.error({ err, task: task.name }, "Task execution error"))
                .finally(() => {
                    activeRuns.delete(task.name);
                    const s = taskStates.get(task.name);

                    if (s) {
                        s.running = false;
                        const parsed = parseInterval(task.every);
                        s.nextRunAt = computeNextRunAt(parsed);
                    }
                });
        }

        const sleepMs = getNextWakeupMs(taskStates, config.tasks);
        log.debug({ sleepMs, activeTasks: activeRuns.size }, "Sleeping");
        await Bun.sleep(sleepMs);
    }

    if (activeRuns.size > 0) {
        log.info({ activeCount: activeRuns.size }, "Waiting for active runs to finish...");
        const deadline = Date.now() + 30_000;

        while (activeRuns.size > 0 && Date.now() < deadline) {
            await Bun.sleep(500);
        }

        if (activeRuns.size > 0) {
            log.warn({ remaining: [...activeRuns] }, "Timed out waiting for active runs");
        }
    }

    log.info("Daemon scheduler stopped");
}

async function executeTask(task: DaemonTask, logsBaseDir: string): Promise<void> {
    const maxAttempts = task.retries + 1;

    sendNotification({
        title: "Daemon",
        subtitle: task.name,
        message: "Task started",
        sound: "Tink",
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log.info({ task: task.name, attempt, maxAttempts }, "Running task");

        const result = await runTask(task, attempt, logsBaseDir);

        if (result.exitCode === 0) {
            log.info({ task: task.name, duration: result.duration_ms }, "Task completed");

            sendNotification({
                title: "Daemon",
                subtitle: task.name,
                message: `Completed in ${formatDurationShort(result.duration_ms)}`,
                sound: "Tink",
            });

            return;
        }

        log.warn(
            { task: task.name, exitCode: result.exitCode, attempt, maxAttempts },
            "Task failed"
        );

        if (attempt < maxAttempts) {
            const backoffMs = Math.min(Math.pow(2, attempt) * 1000, 60_000);
            log.info({ task: task.name, backoffMs }, "Retrying after backoff");
            await Bun.sleep(backoffMs);
        }
    }

    sendNotification({
        title: "Daemon",
        subtitle: task.name,
        message: `Failed after ${maxAttempts} attempt${maxAttempts > 1 ? "s" : ""}, retries exhausted`,
        sound: "Basso",
    });
}

async function initializeTaskStates(
    taskStates: Map<string, TaskState>,
    logsBaseDir: string
): Promise<void> {
    const config = await loadConfig();

    for (const task of config.tasks) {
        const parsed = parseInterval(task.every);
        const runs = listRunsForTask(logsBaseDir, task.name);
        let nextRunAt: Date;

        if (runs.length > 0) {
            const lastRun = new Date(runs[0].startedAt);
            nextRunAt = computeNextRunAt(parsed, lastRun);

            if (nextRunAt < new Date()) {
                nextRunAt = new Date();
            }
        } else {
            nextRunAt = new Date();
        }

        taskStates.set(task.name, { nextRunAt, attemptCount: 0, running: false });
        log.debug({ task: task.name, nextRunAt: nextRunAt.toISOString() }, "Initialized task state");
    }
}

function syncTaskStates(taskStates: Map<string, TaskState>, tasks: DaemonTask[]): void {
    const taskNames = new Set(tasks.map((t) => t.name));

    for (const name of taskStates.keys()) {
        if (!taskNames.has(name)) {
            taskStates.delete(name);
        }
    }

    for (const task of tasks) {
        if (!taskStates.has(task.name)) {
            taskStates.set(task.name, {
                nextRunAt: new Date(),
                attemptCount: 0,
                running: false,
            });
        }
    }
}

function getNextWakeupMs(taskStates: Map<string, TaskState>, tasks: DaemonTask[]): number {
    const now = Date.now();
    let earliest = 60_000;

    for (const task of tasks) {
        if (!task.enabled) {
            continue;
        }

        const state = taskStates.get(task.name);

        if (!state || state.running) {
            continue;
        }

        const ms = state.nextRunAt.getTime() - now;

        if (ms < earliest) {
            earliest = ms;
        }
    }

    return Math.min(Math.max(earliest, 1000), 60_000);
}

function formatDurationShort(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }

    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }

    return `${(ms / 60_000).toFixed(1)}m`;
}
