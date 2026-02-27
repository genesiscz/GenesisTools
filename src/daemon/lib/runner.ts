import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DaemonTask, RunResult } from "./types";

function safeTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function appendJsonl(path: string, data: Record<string, unknown>): void {
    appendFileSync(path, JSON.stringify(data) + "\n");
}

async function streamLines(
    stream: ReadableStream<Uint8Array>,
    type: "stdout" | "stderr",
    logPath: string
): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let partial = "";

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                if (partial) {
                    appendJsonl(logPath, { type, ts: new Date().toISOString(), data: partial });
                }

                break;
            }

            partial += decoder.decode(value, { stream: true });
            const lines = partial.split("\n");
            partial = lines.pop() ?? "";

            for (const line of lines) {
                if (line) {
                    appendJsonl(logPath, { type, ts: new Date().toISOString(), data: line });
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

export async function runTask(
    task: DaemonTask,
    attempt: number,
    logsBaseDir: string
): Promise<RunResult> {
    const runId = crypto.randomUUID().slice(0, 8);
    const taskLogDir = join(logsBaseDir, task.name);
    mkdirSync(taskLogDir, { recursive: true });

    const logFile = join(taskLogDir, `${safeTimestamp()}-${runId}.jsonl`);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    appendJsonl(logFile, {
        type: "meta",
        taskName: task.name,
        command: task.command,
        runId,
        attempt,
        startedAt,
    });

    const proc = Bun.spawn(["sh", "-c", task.command], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
    });

    const stdoutDone = streamLines(proc.stdout, "stdout", logFile);
    const stderrDone = streamLines(proc.stderr, "stderr", logFile);

    const [exitCode] = await Promise.all([proc.exited, stdoutDone, stderrDone]);
    const duration_ms = Date.now() - startMs;

    appendJsonl(logFile, {
        type: "exit",
        ts: new Date().toISOString(),
        code: exitCode,
        duration_ms,
    });

    return { exitCode, duration_ms, logFile };
}
