import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry, RunSummary } from "./types";

const VALID_LOG_TYPES = new Set<string>(["meta", "stdout", "stderr", "exit"]);

function readFirstLine(filePath: string): string | null {
    const fd = openSync(filePath, "r");

    try {
        const buf = Buffer.alloc(4096);
        const bytesRead = readSync(fd, buf, 0, buf.length, 0);

        if (bytesRead === 0) {
            return null;
        }

        const content = buf.toString("utf-8", 0, bytesRead);
        const newlineIdx = content.indexOf("\n");

        return newlineIdx >= 0 ? content.slice(0, newlineIdx) : content;
    } finally {
        closeSync(fd);
    }
}

function readLastLine(filePath: string): string | null {
    const stat = statSync(filePath);

    if (stat.size === 0) {
        return null;
    }

    const fd = openSync(filePath, "r");

    try {
        const chunkSize = Math.min(4096, stat.size);
        const buf = Buffer.alloc(chunkSize);
        const bytesRead = readSync(fd, buf, 0, chunkSize, stat.size - chunkSize);
        const content = buf.toString("utf-8", 0, bytesRead).trimEnd();
        const lastNewline = content.lastIndexOf("\n");

        return lastNewline >= 0 ? content.slice(lastNewline + 1) : content;
    } finally {
        closeSync(fd);
    }
}

export function listTasksWithLogs(logsBaseDir: string): string[] {
    if (!existsSync(logsBaseDir)) {
        return [];
    }

    return readdirSync(logsBaseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("daemon-"))
        .map((d) => d.name)
        .sort();
}

export function listRunsForTask(logsBaseDir: string, taskName: string): RunSummary[] {
    const taskDir = join(logsBaseDir, taskName);

    if (!existsSync(taskDir)) {
        return [];
    }

    const files = readdirSync(taskDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();

    const summaries: RunSummary[] = [];

    for (const file of files) {
        const logFile = join(taskDir, file);

        try {
            const firstLine = readFirstLine(logFile);

            if (!firstLine) {
                continue;
            }

            const meta = JSON.parse(firstLine) as Record<string, unknown>;

            if (meta.type !== "meta" || typeof meta.runId !== "string" || typeof meta.startedAt !== "string") {
                continue;
            }

            let exitCode: number | null = null;
            let duration_ms: number | null = null;

            const lastLine = readLastLine(logFile);

            if (lastLine && lastLine !== firstLine) {
                try {
                    const last = JSON.parse(lastLine) as Record<string, unknown>;

                    if (last.type === "exit") {
                        exitCode = typeof last.code === "number" ? last.code : null;
                        duration_ms = typeof last.duration_ms === "number" ? last.duration_ms : null;
                    }
                } catch {
                    // incomplete log
                }
            }

            summaries.push({
                taskName,
                runId: meta.runId,
                logFile,
                startedAt: meta.startedAt,
                exitCode,
                duration_ms,
                attempt: typeof meta.attempt === "number" ? meta.attempt : 1,
            });
        } catch {
            // skip malformed log files
        }
    }

    return summaries;
}

export function parseLogFile(logFile: string): LogEntry[] {
    if (!existsSync(logFile)) {
        return [];
    }

    const content = readFileSync(logFile, "utf-8").trim();

    if (!content) {
        return [];
    }

    const entries: LogEntry[] = [];

    for (const line of content.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;

            if (typeof parsed.type === "string" && VALID_LOG_TYPES.has(parsed.type)) {
                entries.push(parsed as unknown as LogEntry);
            }
        } catch {
            // skip malformed lines
        }
    }

    return entries;
}
