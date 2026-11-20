import { appendFileSync, mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { launcherConfigForSavedCommand } from "@genesiscz/utils/bun/launcher-config";
import { formatLocalFileTimestamp } from "@genesiscz/utils/date";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type PriorityTools, priorityShellArgv } from "@genesiscz/utils/process/priority";
import { taskWorkingDir } from "./config";
import { taskLogDirName } from "./run-log-name";
import type { DaemonTask, RunContext, RunResult, RunUsage, TaskPriority } from "./types";

/** This checkout's root, where the `tools` entry lives. */
const REPO_ROOT = resolve(import.meta.dir, "../../..");

/**
 * The PATH a task's shell gets: the checkout first, so a task written as `tools <name> ...` resolves
 * to this checkout's `tools`, then the system bin folders, which a launchd job's PATH lacks.
 */
export function taskPath(inherited: string | undefined): string {
    const parts = [REPO_ROOT, ...(inherited ?? "").split(delimiter), "/usr/sbin", "/sbin"].filter(Boolean);
    return [...new Set(parts)].join(delimiter);
}

/** A task without `timeoutMs` is killed after this long. */
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * The stop contract with a task: on timeout the runner SIGTERMs the task's process group and SIGKILLs it
 * `TASK_SIGTERM_GRACE_MS` later. A task that cleans up on SIGTERM bounds that cleanup by
 * `TASK_SIGTERM_CLEANUP_MS`; the extra second is for the exit itself. The grace was 500 ms while the usage
 * poll's cleanup may take up to 2 s, and 123 of 300 timed-out polls escalated to SIGKILL (2026-10-05..12).
 */
export const TASK_SIGTERM_CLEANUP_MS = 2_000;
export const TASK_SIGTERM_GRACE_MS = TASK_SIGTERM_CLEANUP_MS + 1_000;
const STREAM_DRAIN_GRACE_MS = 250;

function safeTimestamp(): string {
    return formatLocalFileTimestamp();
}

function appendJsonl(path: string, data: Record<string, unknown>): void {
    appendFileSync(path, `${SafeJSON.stringify(data)}\n`);
}

async function streamLines(
    stream: ReadableStream<Uint8Array>,
    type: "stdout" | "stderr",
    logPath: string,
    signal: AbortSignal
): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let partial = "";

    const onAbort = (): void => {
        reader.cancel().catch((err) => {
            logger.debug({ err }, "[daemon] stream reader cancel failed during abort cleanup");
        });
    };

    signal.addEventListener("abort", onAbort, { once: true });

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                partial += decoder.decode();

                if (partial) {
                    appendJsonl(logPath, { type, ts: new Date().toISOString(), data: partial });
                }

                break;
            }

            partial += decoder.decode(value, { stream: true });
            const lines = partial.split("\n");
            partial = lines.pop() ?? "";

            for (const line of lines) {
                appendJsonl(logPath, { type, ts: new Date().toISOString(), data: line });
            }
        }
    } finally {
        signal.removeEventListener("abort", onAbort);
        reader.releaseLock();
    }
}

/**
 * The argv a task runs with, by priority (`priorityShellArgv`, src/utils/process/priority.ts). The launchd job is
 * `ProcessType=Standard` (launchd.ts); a plist installed before that is `Background`, and then every child inherits
 * background QoS (throttled CPU and disk), which `high` clears.
 */
export function taskArgv(command: string, priority: TaskPriority, onDisk?: PriorityTools): string[] {
    return priorityShellArgv(command, priority, onDisk);
}

/** Characters of the task name a run's working folder keeps: the name plus the run id stays far below 255 bytes. */
const WORKING_DIR_NAME_CHARS = 64;

/** Milliseconds to three decimals (microseconds): a short run's cores are cpuMs / wallMs, so whole ms would skew it. */
function preciseMs(ms: number): number {
    return Math.round(ms * 1000) / 1000;
}

/**
 * Bun's rusage of a reaped child (microseconds, bytes) as the run log's usage record, with `wallMs`, the child's own
 * lifetime on a monotonic clock. `maxRssMb` is the largest peak of one process (the task process or a child it waited
 * for), not the sum of children that ran at the same time.
 */
export function runUsage(raw: ReturnType<Bun.Subprocess["resourceUsage"]>, wallMs: number): RunUsage | undefined {
    if (!raw) {
        return undefined;
    }

    const userMs = preciseMs(Number(raw.cpuTime.user) / 1000);
    const systemMs = preciseMs(Number(raw.cpuTime.system) / 1000);
    return {
        userMs,
        systemMs,
        cpuMs: preciseMs(userMs + systemMs),
        maxRssMb: Math.round(Number(raw.maxRSS) / 1_048_576),
        wallMs: preciseMs(wallMs),
    };
}

/**
 * Creates a run's working folder exclusively (`mkdtemp`), so it is new and empty even if a run id repeats. The name
 * keeps at most `WORKING_DIR_NAME_CHARS` characters of the task name, so a long valid task name never exceeds the
 * file system's limit for one path component.
 */
function createRunWorkingDir(taskName: string, runId: string): string {
    const parent = taskWorkingDir();
    mkdirSync(parent, { recursive: true });
    const prefix = Array.from(taskLogDirName(taskName)).slice(0, WORKING_DIR_NAME_CHARS).join("");
    return mkdtempSync(join(parent, `${prefix}-${runId}-`));
}

/**
 * Removes a run's working folder when the run left it empty. Files a task wrote there stay, with a warning naming the
 * folder: they are the task's output, and no later run starts in that folder.
 */
function releaseRunWorkingDir(cwd: string, taskName: string): void {
    try {
        rmdirSync(cwd);
    } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;

        if (code === "ENOTEMPTY" || code === "EEXIST") {
            logger.warn({ task: taskName, cwd }, "[daemon] the task left files in its working folder; they stay there");
        } else {
            logger.warn({ task: taskName, cwd, error }, "[daemon] the run's working folder could not be removed");
        }
    }
}

export async function runTask(
    task: DaemonTask,
    attempt: number,
    logsBaseDir: string,
    context: RunContext = { reason: "scheduled", priority: task.priority ?? "normal" }
): Promise<RunResult> {
    const runId = crypto.randomUUID().slice(0, 8);
    const taskLogDir = join(logsBaseDir, taskLogDirName(task.name));
    mkdirSync(taskLogDir, { recursive: true });

    const logFile = join(taskLogDir, `${safeTimestamp()}-${runId}.jsonl`);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const timeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

    appendJsonl(logFile, {
        type: "meta",
        taskName: task.name,
        command: task.command,
        runId,
        attempt,
        startedAt,
        timeoutMs,
        reason: context.reason,
        priority: context.priority,
        ...(context.scheduledFor ? { scheduledFor: context.scheduledFor.toISOString() } : {}),
    });

    const argv = taskArgv(launcherConfigForSavedCommand(task.command), context.priority);
    logger.info(
        { task: task.name, attempt, timeoutMs, logFile, reason: context.reason, priority: context.priority },
        "[daemon] spawning task process"
    );
    logger.debug({ task: task.name, command: task.command }, "[daemon] task command");

    // `detached: true` makes the child a process-group leader (POSIX setsid),
    // so a kill can target the whole group (`sh` + every descendant). Without
    // it, killing the Bun.spawn child only reaps `sh`; a runaway grandchild
    // survives, holds the stdout pipe open, and hangs the result forever.
    const inherited = env.getProcessEnv();
    // A folder of this run's own, new and empty: what one run writes there never reaches another task or a later run.
    const cwd = createRunWorkingDir(task.name, runId);

    try {
        return await runInWorkingDir({ task, attempt, argv, cwd, inherited, logFile, runId, startMs, timeoutMs });
    } finally {
        releaseRunWorkingDir(cwd, task.name);
    }
}

interface RunInWorkingDirOptions {
    task: DaemonTask;
    attempt: number;
    argv: string[];
    cwd: string;
    inherited: ReturnType<typeof env.getProcessEnv>;
    logFile: string;
    runId: string;
    startMs: number;
    timeoutMs: number;
}

/** Spawns the task in its working folder and waits for it; `runTask` removes the folder however this ends. */
async function runInWorkingDir({
    task,
    attempt,
    argv,
    cwd,
    inherited,
    logFile,
    runId,
    startMs,
    timeoutMs,
}: RunInWorkingDirOptions): Promise<RunResult> {
    const proc = Bun.spawn(argv, {
        cwd,
        env: { ...inherited, PATH: taskPath(inherited.PATH) },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        detached: true,
    });
    const spawnedAt = performance.now();

    // POSIX: negative pid signals the whole process group (sh + descendants).
    // pid-verified: negative pid = the process group of a child this function just spawned
    // Windows has no process groups, so process.kill(-pid) throws, the catch
    // falls back to proc.kill (reaps sh only) and a grandchild may leak — the
    // stream-drain abort below still unblocks the result. A true Windows tree
    // kill would need `taskkill /T /F /PID`; add that only if it ever matters.
    const killTree = (signal: "SIGTERM" | "SIGKILL"): void => {
        // pid-verified: same just-spawned child's group
        try {
            // pid-verified: negative pid = the process group of a child this function just spawned
            process.kill(-proc.pid, signal);
        } catch {
            try {
                proc.kill(signal);
            } catch (innerErr) {
                logger.debug({ err: innerErr, pid: proc.pid }, "[daemon] process already gone during killTree");
            }
        }
    };

    const drainAbort = new AbortController();
    const stdoutDone = streamLines(proc.stdout, "stdout", logFile, drainAbort.signal);
    const stderrDone = streamLines(proc.stderr, "stderr", logFile, drainAbort.signal);
    let timedOut = false;
    let exited = false;
    let forceKillTimer: Timer | undefined;
    const timeoutTimer = setTimeout(() => {
        timedOut = true;
        logger.warn({ task: task.name, attempt, timeoutMs, logFile }, "[daemon] task timed out, sending SIGTERM");
        killTree("SIGTERM");
        forceKillTimer = setTimeout(() => {
            if (!exited) {
                logger.warn(
                    { task: task.name, attempt, timeoutMs, logFile },
                    "[daemon] task still running, sending SIGKILL"
                );
                killTree("SIGKILL");
            }
        }, TASK_SIGTERM_GRACE_MS);
    }, timeoutMs);

    timeoutTimer.unref?.();

    const rawExitCode = await proc.exited;
    const wallMs = performance.now() - spawnedAt;
    exited = true;
    clearTimeout(timeoutTimer);

    if (forceKillTimer) {
        clearTimeout(forceKillTimer);
    }

    // The child exited, but a detached grandchild that escaped the kill could
    // still hold the pipe open. Give the streams a bounded grace to flush,
    // then abort the readers so the result can never hang on stream drain.
    await Promise.race([Promise.all([stdoutDone, stderrDone]), Bun.sleep(STREAM_DRAIN_GRACE_MS)]);
    drainAbort.abort();
    await Promise.allSettled([stdoutDone, stderrDone]);

    const duration_ms = Date.now() - startMs;
    const exitCode = timedOut ? null : rawExitCode;
    const usage = runUsage(proc.resourceUsage(), wallMs);

    appendJsonl(logFile, {
        type: "exit",
        ts: new Date().toISOString(),
        code: exitCode,
        duration_ms,
        ...(timedOut ? { timedOut: true } : {}),
        ...(usage ? { usage } : {}),
    });

    if (timedOut) {
        logger.warn({ task: task.name, attempt, duration_ms, usage, logFile }, "[daemon] task process timed out");
    } else {
        logger.info(
            { task: task.name, attempt, exitCode, duration_ms, usage, logFile },
            "[daemon] task process exited"
        );
    }

    return { exitCode, duration_ms, logFile, runId, ...(usage ? { usage } : {}) };
}
