import { logger } from "@app/logger";
import { wakefulSleep } from "@app/utils/async";
import { dispatchNotification } from "@app/utils/notifications";
import { loadConfig } from "./config";
import { computeNextRunAt, parseInterval } from "./interval";
import { listRunsForTask } from "./log-reader";
import { pruneTaskRunLogs } from "./retention";
import { runTask } from "./runner";
import type { DaemonTask, TaskState } from "./types";

const { log } = logger.scoped("daemon");

/** Scheduler's scoped logger — exported for tests that spy on log calls. */
export const daemonLog = log;

function jitteredNow(taskName: string): Date {
    let hash = 0;

    for (let i = 0; i < taskName.length; i++) {
        hash = (hash * 31 + taskName.charCodeAt(i)) >>> 0;
    }

    return new Date(Date.now() + (hash % 2000));
}

export { jitteredNow };

export function logSchedulerHeartbeat(sleepMs: number, activeTasks: number): void {
    log.debug({ sleepMs, activeTasks }, "[daemon] scheduler tick");
}

export function logSchedulerLoopFailure(err: unknown, consecutiveFailures: number): void {
    const timestamp = new Date().toISOString();
    log.error(
        { err, consecutiveFailures, timestamp },
        "[daemon] scheduler loop iteration failed; retrying after backoff"
    );
}

export async function runSchedulerLoop(logsBaseDir: string): Promise<void> {
    let running = true;
    const activeRuns = new Set<string>();
    const taskStates = new Map<string, TaskState>();

    const shutdown = () => {
        running = false;
    };

    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    try {
        log.info({ logsBaseDir }, "[daemon] scheduler started");

        await initializeTaskStates(taskStates, logsBaseDir);

        let consecutiveLoopFailures = 0;

        while (running) {
            try {
                consecutiveLoopFailures = 0;
                const config = await loadConfig();
                const now = new Date();

                syncTaskStates(taskStates, config.tasks);

                dispatchDueTasks(config.tasks, taskStates, activeRuns, logsBaseDir, now);

                const sleepMs = getNextWakeupMs(taskStates, config.tasks);
                logSchedulerHeartbeat(sleepMs, activeRuns.size);
                await wakefulSleep(sleepMs, {
                    shouldAbort: () => !running,
                    onWallClockJump: ({ elapsedMs, expectedMs }) => {
                        log.info(
                            { elapsedMs, expectedMs },
                            "[daemon] wall-clock jumped (likely wake from sleep/hibernate); resuming scheduler"
                        );
                    },
                });
            } catch (err) {
                consecutiveLoopFailures++;
                logSchedulerLoopFailure(err, consecutiveLoopFailures);
                await wakefulSleep(5000, { shouldAbort: () => !running });
            }
        }

        if (activeRuns.size > 0) {
            log.info(
                { activeCount: activeRuns.size, activeTasks: [...activeRuns] },
                "[daemon] waiting for active runs"
            );
            const deadline = Date.now() + 30_000;

            while (activeRuns.size > 0 && Date.now() < deadline) {
                await Bun.sleep(500);
            }

            if (activeRuns.size > 0) {
                log.warn({ remaining: [...activeRuns] }, "[daemon] timed out waiting for active runs");
            }
        }

        log.info("[daemon] scheduler stopped");
    } finally {
        process.off("SIGTERM", shutdown);
        process.off("SIGINT", shutdown);
    }
}

export function dispatchDueTasks(
    tasks: DaemonTask[],
    taskStates: Map<string, TaskState>,
    activeRuns: Set<string>,
    logsBaseDir: string,
    now: Date = new Date()
): void {
    for (const task of tasks) {
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
        const scheduledAt = state.nextRunAt;

        executeTask(task, logsBaseDir)
            .catch((err) => {
                log.error({ err, task: task.name }, "[daemon] task execution error");
            })
            .finally(() => {
                activeRuns.delete(task.name);
                const s = taskStates.get(task.name);

                if (s) {
                    s.running = false;

                    try {
                        const parsed = parseInterval(task.every);
                        const next = computeNextRunAt(parsed, scheduledAt);
                        s.nextRunAt = next < new Date() ? new Date() : next;
                    } catch (err) {
                        s.nextRunAt = new Date(Date.now() + 60_000);
                        log.error(
                            { err, task: task.name, every: task.every },
                            "[daemon] invalid task interval; deferring 60s"
                        );
                    }
                }
            });
    }
}

async function executeTask(task: DaemonTask, logsBaseDir: string): Promise<void> {
    try {
        await runAttempts(task, logsBaseDir);
    } finally {
        if (task.retention) {
            try {
                pruneTaskRunLogs(logsBaseDir, task.name, task.retention);
            } catch (err) {
                log.warn({ err, task: task.name }, "[daemon] retention prune failed");
            }
        }
    }
}

async function runAttempts(task: DaemonTask, logsBaseDir: string): Promise<void> {
    const maxAttempts = task.retries + 1;

    const shouldNotify = task.notify !== false;

    if (shouldNotify) {
        dispatchNotification({
            app: "daemon",
            title: "Daemon",
            subtitle: task.name,
            message: "Task started",
        });
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log.info({ task: task.name, attempt, maxAttempts, timeoutMs: task.timeoutMs }, "[daemon] running task");

        const result = await runTask(task, attempt, logsBaseDir);

        if (result.exitCode === 0) {
            log.info(
                { task: task.name, duration_ms: result.duration_ms, logFile: result.logFile },
                "[daemon] task completed"
            );

            if (shouldNotify) {
                dispatchNotification({
                    app: "daemon",
                    title: "Daemon",
                    subtitle: task.name,
                    message: `Completed in ${formatDurationShort(result.duration_ms)}`,
                });
            }

            return;
        }

        log.warn(
            { task: task.name, exitCode: result.exitCode, attempt, maxAttempts, logFile: result.logFile },
            "[daemon] task failed"
        );

        if (attempt < maxAttempts) {
            const backoffMs = Math.min(2 ** attempt * 1000, 60_000);
            log.info({ task: task.name, backoffMs }, "[daemon] retrying task after backoff");
            await Bun.sleep(backoffMs);
        }
    }

    if (shouldNotify) {
        dispatchNotification({
            app: "daemon",
            title: "Daemon",
            subtitle: task.name,
            message: `Failed after ${maxAttempts} attempt${maxAttempts > 1 ? "s" : ""}, retries exhausted`,
        });
    }
}

async function initializeTaskStates(taskStates: Map<string, TaskState>, logsBaseDir: string): Promise<void> {
    const config = await loadConfig();

    for (const task of config.tasks) {
        const parsed = parseInterval(task.every);
        const runs = listRunsForTask(logsBaseDir, task.name, 1);
        let nextRunAt: Date;

        if (runs.length > 0) {
            const lastRun = new Date(runs[0].startedAt);
            nextRunAt = computeNextRunAt(parsed, lastRun);

            if (nextRunAt < new Date()) {
                nextRunAt = new Date();
            }
        } else {
            nextRunAt = jitteredNow(task.name);
        }

        taskStates.set(task.name, { nextRunAt, attemptCount: 0, running: false });
        log.debug({ task: task.name, nextRunAt: nextRunAt.toISOString() }, "[daemon] initialized task state");
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
                nextRunAt: jitteredNow(task.name),
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
