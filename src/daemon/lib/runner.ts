import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import appLogger from "@app/logger";
import { formatLocalFileTimestamp } from "@app/utils/date";
import { SafeJSON } from "@app/utils/json";
import type { DaemonTask, RunResult } from "./types";

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const FORCE_KILL_GRACE_MS = 500;
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
        reader.cancel().catch(() => {});
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

export async function runTask(task: DaemonTask, attempt: number, logsBaseDir: string): Promise<RunResult> {
    const runId = crypto.randomUUID().slice(0, 8);
    const safeTaskName = task.name.replace(/[/\\]/g, "_") || "unnamed-task";
    const taskLogDir = join(logsBaseDir, safeTaskName);
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
    });

    appLogger.info({ task: task.name, attempt, timeoutMs, logFile }, "[daemon] spawning task process");
    appLogger.debug({ task: task.name, command: task.command }, "[daemon] task command");

    // `detached: true` makes the child a process-group leader (POSIX setsid),
    // so a kill can target the whole group (`sh` + every descendant). Without
    // it, killing the Bun.spawn child only reaps `sh`; a runaway grandchild
    // survives, holds the stdout pipe open, and hangs the result forever.
    const proc = Bun.spawn(["sh", "-c", task.command], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        detached: true,
    });

    const killTree = (signal: "SIGTERM" | "SIGKILL"): void => {
        try {
            process.kill(-proc.pid, signal);
        } catch {
            try {
                proc.kill(signal);
            } catch {
                // Process already gone — nothing to signal.
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
        appLogger.warn({ task: task.name, attempt, timeoutMs, logFile }, "[daemon] task timed out, sending SIGTERM");
        killTree("SIGTERM");
        forceKillTimer = setTimeout(() => {
            if (!exited) {
                appLogger.warn(
                    { task: task.name, attempt, timeoutMs, logFile },
                    "[daemon] task still running, sending SIGKILL"
                );
                killTree("SIGKILL");
            }
        }, FORCE_KILL_GRACE_MS);
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
        appLogger.warn({ task: task.name, attempt, duration_ms, logFile }, "[daemon] task process timed out");
    } else {
        appLogger.info({ task: task.name, attempt, exitCode, duration_ms, logFile }, "[daemon] task process exited");
    }

    return { exitCode, duration_ms, logFile };
}
