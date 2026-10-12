import { wakefulSleep, withTimeout } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { loadConfig } from "./config";
import { computeNextRunAt, parseInterval } from "./interval";
import { listRunsForTask } from "./log-reader";
import { latestSlotAtOrBefore, missedRunOf, PRIORITY_RANK, planAfterRun, planDueRun, priorityOf } from "./missed-run";
import { pruneTaskRunLogs } from "./retention";
import { runTask } from "./runner";
import type { DaemonTask, RunContext, TaskState } from "./types";
import { isFullWake, WAKE_CHECK_TIMEOUT_MS } from "./wake";

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
/** Bound on config loading so a stalled read surfaces as a loop failure, not an eternal await. */
export const LOAD_CONFIG_TIMEOUT_MS = 15_000;
/** A task that keeps failing gets one banner, then a reminder this often while the streak lasts. */
export const FAILURE_REMINDER_MS = 6 * 3_600_000;

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
    /** Test seam: how often wakefulSleep re-reads shouldAbort while the loop is idle. */
    wakefulTickMs?: number;
    /** Test seam for process.exit. */
    exit?: (code: number) => void;
    /** Test seam for notifications (threaded through to task runs). */
    notify?: NotifyFn;
    /** Test seam for the task runner (threaded through to task runs). */
    runTask?: RunTaskFn;
    /** Test seam for config loading. */
    loadConfig?: LoadConfigFn;
    /** Test seam for the full-wake check an `on-wake` catch-up waits for. */
    fullWake?: () => Promise<boolean>;
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

/**
 * `Storage.getConfig` reads the file without a lock, so a timeout here is a stalled read or a starved
 * process (the daemon runs as a Background job; on 2026-10-10 its timers fired 15-80 s late under load).
 */
function loadConfigTimeoutError(timeoutMs: number): Error {
    return new Error(
        `loadConfig timed out after ${timeoutMs}ms (the read takes no lock: it stalled, or the daemon was starved of CPU or I/O)`
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
    const wakefulTickMs = resilience.wakefulTickMs;
    const exit = resilience.exit ?? ((code: number) => process.exit(code));
    const notify = resilience.notify ?? dispatchNotification;
    const runTaskImpl = resilience.runTask ?? runTask;
    const loadConfigImpl = resilience.loadConfig ?? loadConfig;
    const fullWakeImpl = resilience.fullWake ?? isFullWake;

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
    //
    // Silence only counts while the process could run. During macOS sleep (and between the short
    // DarkWakes of Maintenance Sleep) neither the loop nor this timer runs, yet the wall clock moves
    // on, so the first sample after a wake read 8-14 min of "silence" and killed a healthy daemon
    // (2026-10-06 15:30 and 20:03, 2026-10-11 21:32 UTC, each in the first seconds of a DarkWake).
    // A sample that arrives more than one interval late measures that gap; it is credited to the
    // loop, so a real hang still trips after `wedgeThresholdMs` of time the process was running.
    let lastTickAt = Date.now();
    let lastSampleAt = lastTickAt;
    const watchdog = setInterval(() => {
        const sampledAt = Date.now();
        const lateMs = sampledAt - lastSampleAt - watchdogIntervalMs;
        lastSampleAt = sampledAt;

        if (!running) {
            return;
        }

        if (lateMs > watchdogIntervalMs) {
            lastTickAt = Math.min(sampledAt, lastTickAt + lateMs);
            log.info(
                { suspendedMs: lateMs, watchdogIntervalMs },
                "[daemon] watchdog sampled late (process suspended); the gap is not counted as scheduler silence"
            );
        }

        const silentMs = sampledAt - lastTickAt;

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
                    loadConfigTimeoutError(loadConfigTimeoutMs)
                );
                const now = new Date();

                syncTaskStates(taskStates, config.tasks);

                // Asked only while an `on-wake` task is due, since the check costs a process spawn.
                const fullWake = waitsForWake(config.tasks, taskStates, now)
                    ? await withTimeout(
                          fullWakeImpl(),
                          WAKE_CHECK_TIMEOUT_MS,
                          new Error("the full-wake check timed out")
                      )
                    : true;

                dispatchDueTasks({
                    tasks: config.tasks,
                    taskStates,
                    activeRuns,
                    logsBaseDir,
                    now,
                    notify,
                    runTask: runTaskImpl,
                    fullWake,
                });

                const sleepMs = getNextWakeupMs(taskStates, config.tasks);
                logSchedulerHeartbeat(sleepMs, activeRuns.size);
                await wakefulSleep(sleepMs, {
                    tickMs: wakefulTickMs,
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
                await wakefulSleep(5000, { tickMs: wakefulTickMs, shouldAbort: () => !running });
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

/** An enabled `on-wake` task is due now, so this tick has to know whether the Mac is fully awake. */
function waitsForWake(tasks: DaemonTask[], taskStates: Map<string, TaskState>, now: Date): boolean {
    return tasks.some((task) => {
        const state = taskStates.get(task.name);
        return task.enabled && missedRunOf(task).mode === "on-wake" && state !== undefined && now >= state.nextRunAt;
    });
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
    /** The Mac is fully awake, not in a DarkWake. Only an `on-wake` catch-up waits for it. Default: true. */
    fullWake?: boolean;
}): void {
    const {
        tasks,
        taskStates,
        activeRuns,
        logsBaseDir,
        now = new Date(),
        notify = dispatchNotification,
        runTask: runTaskImpl = runTask,
        fullWake = true,
    } = options;

    // Several tasks due in one tick start in priority order (stable within a priority).
    const due = tasks
        .filter((task) => {
            const state = taskStates.get(task.name);
            return task.enabled && !activeRuns.has(task.name) && state !== undefined && now >= state.nextRunAt;
        })
        .sort((a, b) => PRIORITY_RANK[priorityOf(a)] - PRIORITY_RANK[priorityOf(b)]);

    for (const task of due) {
        const state = taskStates.get(task.name);

        if (!state) {
            continue;
        }

        const plan = planDueRun({ task, state, now, fullWake });

        if (plan.action === "defer") {
            state.slotAt = state.slotAt ?? state.nextRunAt;
            state.nextRunAt = plan.until;
            state.reason = plan.reason;
            state.retryQueue = plan.retryQueue ?? state.retryQueue;
            log.info(
                { task: task.name, until: plan.until.toISOString(), slot: state.slotAt.toISOString(), why: plan.why },
                "[daemon] missed run deferred"
            );
            continue;
        }

        if (plan.action === "skip") {
            log.info({ task: task.name, next: plan.next.toISOString(), why: plan.why }, "[daemon] missed run skipped");
            state.nextRunAt = plan.next;
            state.slotAt = plan.next;
            state.reason = undefined;
            state.retryQueue = undefined;
            continue;
        }

        activeRuns.add(task.name);
        state.running = true;
        const scheduledAt = state.nextRunAt;
        const context: RunContext = { reason: plan.reason, priority: plan.priority, scheduledFor: plan.scheduledFor };
        let ok = false;

        executeTask(task, logsBaseDir, notify, runTaskImpl, { state, at: now.getTime() }, context)
            .then((succeeded) => {
                ok = succeeded;
            })
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

                        if (parsed.isTimeOfDay) {
                            const after = planAfterRun({ task, state: s, ok, now: new Date() });
                            s.nextRunAt = after.nextRunAt;
                            s.reason = after.reason === "scheduled" ? undefined : after.reason;
                            s.slotAt = after.slotAt;
                            s.retryQueue = after.retryQueue;
                        } else {
                            const next = computeNextRunAt(parsed, scheduledAt);
                            s.nextRunAt = next < new Date() ? new Date() : next;
                        }
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

/** Runs a task with its retries; true when an attempt succeeded. */
async function executeTask(
    task: DaemonTask,
    logsBaseDir: string,
    notify: NotifyFn,
    runTaskImpl: RunTaskFn,
    streak: StreakContext,
    context: RunContext
): Promise<boolean> {
    try {
        return await runAttempts(task, logsBaseDir, notify, runTaskImpl, streak, context);
    } finally {
        // Not awaited: the task stays in `activeRuns` until this function returns, and a prune on a throttled
        // disk took up to 82 s, which would push the task's next run back by as much. Overlapping prunes of one
        // task join each other inside `pruneTaskRunLogs`.
        if (task.retention) {
            void pruneTaskRunLogs(logsBaseDir, task.name, task.retention).catch((err) => {
                log.warn({ err, task: task.name }, "[daemon] retention prune failed");
            });
        }
    }
}

interface StreakContext {
    state: TaskState;
    /** When this run was dispatched, epoch ms. */
    at: number;
}

async function runAttempts(
    task: DaemonTask,
    logsBaseDir: string,
    notify: NotifyFn,
    runTaskImpl: RunTaskFn,
    { state, at }: StreakContext,
    context: RunContext
): Promise<boolean> {
    const maxAttempts = task.retries + 1;

    const notifyProgress = task.notify === undefined || task.notify === true;
    const notifyFailure = task.notify !== false;

    if (notifyProgress) {
        notify({
            app: "daemon",
            title: "Daemon",
            subtitle: task.name,
            message: "Task started",
        });
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log.info(
            {
                task: task.name,
                attempt,
                maxAttempts,
                timeoutMs: task.timeoutMs,
                notify: task.notify ?? true,
                reason: context.reason,
                priority: context.priority,
            },
            "[daemon] running task"
        );

        const result = await runTaskImpl(task, attempt, logsBaseDir, context);

        if (result.exitCode === 0) {
            log.info(
                { task: task.name, duration_ms: result.duration_ms, logFile: result.logFile },
                "[daemon] task completed"
            );

            state.failureStreak = undefined;

            if (notifyProgress) {
                notify({
                    app: "daemon",
                    title: "Daemon",
                    subtitle: task.name,
                    message: `Completed in ${formatDurationShort(result.duration_ms)}`,
                });
            }

            return true;
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

    const streak = state.failureStreak ?? { count: 0, notifiedAt: 0 };
    streak.count += 1;
    state.failureStreak = streak;

    // One banner per streak, then a reminder: a task that fails every 15 minutes for a day is one
    // problem, and 38 identical banners (observed 2026-10-05) hide every other message.
    const first = streak.count === 1;

    if (notifyFailure && (first || at - streak.notifiedAt >= FAILURE_REMINDER_MS)) {
        streak.notifiedAt = at;
        notify({
            app: "daemon",
            title: "Daemon",
            subtitle: task.name,
            message: first
                ? `Failed after ${maxAttempts} attempt${maxAttempts > 1 ? "s" : ""}, retries exhausted`
                : `Still failing: ${streak.count} runs in a row, retries exhausted`,
        });
    } else if (notifyFailure) {
        log.info(
            { task: task.name, streak: streak.count },
            "[daemon] failure banner skipped, the streak was announced"
        );
    }

    return false;
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
        loadConfigTimeoutError(loadConfigTimeoutMs)
    );

    for (const task of config.tasks) {
        const parsed = parseInterval(task.every);
        const runs = listRunsForTask(logsBaseDir, task.name, 1);
        const now = new Date();
        let nextRunAt: Date;
        let slotAt: Date | undefined;

        if (runs.length > 0) {
            const lastRun = new Date(runs[0].startedAt);
            nextRunAt = computeNextRunAt(parsed, lastRun);

            if (nextRunAt < now && parsed.isTimeOfDay) {
                // A slot passed while the daemon was down: keep the latest one, so the dispatch sees it as missed and
                // applies the task's missed-run policy (one catch-up, however many slots passed).
                nextRunAt = latestSlotAtOrBefore(parsed, now);
            } else if (nextRunAt < now) {
                nextRunAt = now;
            }

            slotAt = parsed.isTimeOfDay ? nextRunAt : undefined;
        } else {
            nextRunAt = jitteredNow(task.name);
        }

        taskStates.set(task.name, { nextRunAt, attemptCount: 0, running: false, slotAt });
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
