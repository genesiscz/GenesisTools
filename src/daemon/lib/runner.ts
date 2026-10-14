import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { formatLocalFileTimestamp } from "@genesiscz/utils/date";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { taskLogDirName } from "./run-log-name";
import type { DaemonTask, RunContext, RunResult, TaskPriority } from "./types";

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

const PERL = "/usr/bin/perl";
const TASKPOLICY = "/usr/sbin/taskpolicy";

/**
 * Lifts the process out of darwin background (`setpriority(PRIO_DARWIN_PROCESS, 0, 0)`, PRIO_DARWIN_PROCESS = 4),
 * then execs the task. A process may clear its own background state even when it inherited it, which `taskpolicy -B`
 * cannot do for another process (measured 2026-10-12: a `taskpolicy -b` child stays at priority 4 after
 * `taskpolicy -B -p`, and reaches 31 after clearing its own).
 */
const RAISE_FROM_BACKGROUND =
    'setpriority(4, 0, 0) or warn "setpriority: $!\\n"; exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\\n"';

/**
 * The argv a task runs with, by priority. The launchd job is `ProcessType=Standard` (launchd.ts); a plist installed
 * before that is `Background`, and then every child inherits background QoS (throttled CPU and disk):
 * - `low`: `taskpolicy -b`, background QoS whatever the daemon's own QoS is. Without /usr/sbin/taskpolicy (any
 *   system but macOS) it runs as `normal`.
 * - `normal`: the daemon's QoS.
 * - `high`: the child clears any inherited background state before the command starts, so it is never throttled.
 *   Without /usr/bin/perl it runs as `normal`.
 */
export function taskArgv(
    command: string,
    priority: TaskPriority,
    onDisk = { perl: existsSync(PERL), taskpolicy: existsSync(TASKPOLICY) }
): string[] {
    const shell = ["sh", "-c", command];

    if (priority === "low" && onDisk.taskpolicy) {
        return [TASKPOLICY, "-b", ...shell];
    }

    if (priority === "high" && onDisk.perl) {
        return [PERL, "-e", RAISE_FROM_BACKGROUND, ...shell];
    }

    return shell;
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

    const argv = taskArgv(task.command, context.priority);
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
    const proc = Bun.spawn(argv, {
        env: { ...inherited, PATH: taskPath(inherited.PATH) },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        detached: true,
    });

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

    appendJsonl(logFile, {
        type: "exit",
        ts: new Date().toISOString(),
        code: exitCode,
        duration_ms,
        ...(timedOut ? { timedOut: true } : {}),
    });

    if (timedOut) {
        logger.warn({ task: task.name, attempt, duration_ms, logFile }, "[daemon] task process timed out");
    } else {
        logger.info({ task: task.name, attempt, exitCode, duration_ms, logFile }, "[daemon] task process exited");
    }

    return { exitCode, duration_ms, logFile, runId };
}
