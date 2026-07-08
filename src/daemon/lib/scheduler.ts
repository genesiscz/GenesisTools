import { logger } from "@app/logger";
import { wakefulSleep, withTimeout } from "@app/utils/async";
import { dispatchNotification } from "@app/utils/notifications";
import { loadConfig } from "./config";
import { computeNextRunAt, parseInterval } from "./interval";
import { listRunsForTask } from "./log-reader";
import { pruneTaskRunLogs } from "./retention";
import { runTask } from "./runner";
import type { DaemonTask, TaskState } from "./types";

const { log } = logger.scoped("daemon");

/** Exit code when the wedge watchdog fires — launchd (KeepAlive) respawns a fresh daemon. */
export const EXIT_WEDGED = 86;
/** Exit code when the per-tick pidfile ownership check fails (a usurper owns the scope). */
export const EXIT_OWNERSHIP_LOST = 87;
/** How long after the first SIGTERM/SIGINT the daemon force-exits if the loop never unwound. */
export const HARD_EXIT_GRACE_MS = 20_000;
/** Watchdog sampling interval. */
export const WATCHDOG_INTERVAL_MS = 60_000;
/** Loop silence beyond this = wedged (the loop must tick at least every 60s by design). */
export const WEDGE_THRESHOLD_MS = 5 * 60_000;
/** Bound on config loading so a stuck Storage lock surfaces as a loop failure, not an eternal await. */
export const LOAD_CONFIG_TIMEOUT_MS = 15_000;

/** Notification dispatch seam — tests inject a no-op so `bun test` never fires real banners. */
export type NotifyFn = typeof dispatchNotification;
/** Task-runner seam — tests inject a stub instead of `mock.module("./runner")`, which is
 *  process-global in bun and leaks into every later test file (it made runner.test.ts see
 *  the mock and fail suite-only). */
export type RunTaskFn = typeof runTask;
/** Config-loader seam — same rationale as RunTaskFn (a `mock.module("./config")` would leak). */
export type LoadConfigFn = typeof loadConfig;

/**
 * Resilience seams for runSchedulerLoop, born from the Jul 3/6 incident
 * (wedged-but-alive scheduler, unkillable by SIGTERM, zombies after pidfile
 * theft). Every threshold is overridable so tests exercise the paths without
 * minute-long sleeps; `exit` exists because process.exit is untestable.
 */
export type SchedulerResilienceOptions = {
    /** Per-tick ownership check; false = a usurper owns the pidfile, self-terminate. */
    verifyOwnership?: () => boolean;
    hardExitGraceMs?: number;
    watchdogIntervalMs?: number;
    wedgeThresholdMs?: number;
    loadConfigTimeoutMs?: number;
    /** Test seam for process.exit. */
    exit?: (code: number) => void;
    /** Test seam for notifications (threaded through to task runs). */
    notify?: NotifyFn;
    /** Test seam for the task runner (threaded through to task runs). */
    runTask?: RunTaskFn;
    /** Test seam for config loading. */
    loadConfig?: LoadConfigFn;
};

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

export async function runSchedulerLoop(
    logsBaseDir: string,
    resilience: SchedulerResilienceOptions = {}
): Promise<void> {
    let running = true;
    const activeRuns = new Set<string>();
    const taskStates = new Map<string, TaskState>();

    const hardExitGraceMs = resilience.hardExitGraceMs ?? HARD_EXIT_GRACE_MS;
    const watchdogIntervalMs = resilience.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS;
    const wedgeThresholdMs = resilience.wedgeThresholdMs ?? WEDGE_THRESHOLD_MS;
    const loadConfigTimeoutMs = resilience.loadConfigTimeoutMs ?? LOAD_CONFIG_TIMEOUT_MS;
    const exit = resilience.exit ?? ((code: number) => process.exit(code));
    const notify = resilience.notify ?? dispatchNotification;
    const runTaskImpl = resilience.runTask ?? runTask;
    const loadConfigImpl = resilience.loadConfig ?? loadConfig;

    // Jul 6 incident: the old `process.once` handler only flipped `running`,
    // so a loop wedged inside an await made the daemon unkillable by SIGTERM
    // (the flag was never re-read). Now the first signal flips the flag AND
    // arms an unref'd hard-exit timer; a second signal exits immediately.
    let signalCount = 0;
    let hardExitTimer: ReturnType<typeof setTimeout> | null = null;

    const shutdown = (signal: string) => () => {
        signalCount++;

        if (signalCount > 1) {
            log.error({ signal }, "[daemon] repeated shutdown signal; exiting immediately");
            exit(1);
            return;
        }

        running = false;
        log.info({ signal, graceMs: hardExitGraceMs }, "[daemon] shutdown requested");
        hardExitTimer = setTimeout(() => {
            log.error(
                { signal, graceMs: hardExitGraceMs },
                "[daemon] loop did not unwind within the shutdown grace; force-exiting"
            );
            exit(1);
        }, hardExitGraceMs);
        hardExitTimer.unref();
    };

    const onSigterm = shutdown("SIGTERM");
    const onSigint = shutdown("SIGINT");
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);

    // Wedge watchdog (Jul 6 incident: the scheduler went silent for 2 days
    // while the process stayed "running"). The loop must tick at least every
    // 60s by construction; sustained silence means a body await hung — exit
    // with a distinct code and let launchd's KeepAlive respawn a fresh daemon.
    let lastTickAt = Date.now();
    const watchdog = setInterval(() => {
        if (!running) {
            return;
        }

        const silentMs = Date.now() - lastTickAt;

        if (silentMs > wedgeThresholdMs) {
            log.error(
                { silentMs, wedgeThresholdMs },
                "[daemon] scheduler wedged (no tick within threshold); exiting for launchd respawn"
            );
            exit(EXIT_WEDGED);
        }
    }, watchdogIntervalMs);
    watchdog.unref();

    try {
        log.info({ logsBaseDir }, "[daemon] scheduler started");

        await initializeTaskStates(taskStates, logsBaseDir, loadConfigTimeoutMs, loadConfigImpl);

        let consecutiveLoopFailures = 0;

        while (running) {
            lastTickAt = Date.now();

            try {
                // Jul 3 zombie class: a daemon whose pidfile was stolen must
                // not keep running as an untracked duplicate scheduler.
                if (resilience.verifyOwnership && !resilience.verifyOwnership()) {
                    log.error("[daemon] pidfile ownership lost (usurped or removed); exiting");
                    exit(EXIT_OWNERSHIP_LOST);
                    return;
                }

                const config = await withTimeout(
                    loadConfigImpl(),
                    loadConfigTimeoutMs,
                    new Error(`loadConfig timed out after ${loadConfigTimeoutMs}ms (stuck config lock?)`)
                );
                const now = new Date();

                syncTaskStates(taskStates, config.tasks);

                dispatchDueTasks({
                    tasks: config.tasks,
                    taskStates,
                    activeRuns,
                    logsBaseDir,
                    now,
                    notify,
                    runTask: runTaskImpl,
                });

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
                consecutiveLoopFailures = 0;
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
        process.off("SIGTERM", onSigterm);
        process.off("SIGINT", onSigint);
        clearInterval(watchdog);

        if (hardExitTimer !== null) {
            clearTimeout(hardExitTimer);
        }
    }
}

export function dispatchDueTasks(options: {
    tasks: DaemonTask[];
    taskStates: Map<string, TaskState>;
    activeRuns: Set<string>;
    logsBaseDir: string;
    now?: Date;
    /** Notification seam — tests MUST pass a no-op so `bun test` never fires real banners. */
    notify?: NotifyFn;
    /** Task-runner seam — tests inject a stub here instead of a leaking `mock.module`. */
    runTask?: RunTaskFn;
}): void {
    const {
        tasks,
        taskStates,
        activeRuns,
        logsBaseDir,
        now = new Date(),
        notify = dispatchNotification,
        runTask: runTaskImpl = runTask,
    } = options;

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

        executeTask(task, logsBaseDir, notify, runTaskImpl)
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

async function executeTask(
    task: DaemonTask,
    logsBaseDir: string,
    notify: NotifyFn,
    runTaskImpl: RunTaskFn
): Promise<void> {
    try {
        await runAttempts(task, logsBaseDir, notify, runTaskImpl);
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

async function runAttempts(
    task: DaemonTask,
    logsBaseDir: string,
    notify: NotifyFn,
    runTaskImpl: RunTaskFn
): Promise<void> {
    const maxAttempts = task.retries + 1;

    const shouldNotify = task.notify !== false;

    if (shouldNotify) {
        notify({
            app: "daemon",
            title: "Daemon",
            subtitle: task.name,
            message: "Task started",
        });
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log.info({ task: task.name, attempt, maxAttempts, timeoutMs: task.timeoutMs }, "[daemon] running task");

        const result = await runTaskImpl(task, attempt, logsBaseDir);

        if (result.exitCode === 0) {
            log.info(
                { task: task.name, duration_ms: result.duration_ms, logFile: result.logFile },
                "[daemon] task completed"
            );

            if (shouldNotify) {
                notify({
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
        notify({
            app: "daemon",
            title: "Daemon",
            subtitle: task.name,
            message: `Failed after ${maxAttempts} attempt${maxAttempts > 1 ? "s" : ""}, retries exhausted`,
        });
    }
}

async function initializeTaskStates(
    taskStates: Map<string, TaskState>,
    logsBaseDir: string,
    loadConfigTimeoutMs: number = LOAD_CONFIG_TIMEOUT_MS,
    loadConfigImpl: LoadConfigFn = loadConfig
): Promise<void> {
    const config = await withTimeout(
        loadConfigImpl(),
        loadConfigTimeoutMs,
        new Error(`loadConfig timed out after ${loadConfigTimeoutMs}ms (stuck config lock?)`)
    );

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
