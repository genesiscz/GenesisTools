import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry, RunSummary } from "./types";

const VALID_LOG_TYPES = new Set<string>(["meta", "stdout", "stderr", "exit"]);

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
            const content = readFileSync(logFile, "utf-8").trim();
            const lines = content.split("\n");

            if (lines.length === 0) {
                continue;
            }

            const meta = JSON.parse(lines[0]) as Record<string, unknown>;

            if (meta.type !== "meta" || typeof meta.runId !== "string" || typeof meta.startedAt !== "string") {
                continue;
            }

            let exitCode: number | null = null;
            let duration_ms: number | null = null;

            if (lines.length > 1) {
                try {
                    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;

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
