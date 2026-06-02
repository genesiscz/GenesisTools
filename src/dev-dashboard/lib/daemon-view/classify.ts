import type { LogEntry } from "@app/daemon/lib/types";

export type LogLineClass = "info" | "warn" | "error" | "exit";

/** stdout/stderr substrings (lowercased) that flip a line to error. Word-ish, deliberately small. */
const ERROR_PATTERNS = ["error", "failed", "failure", "exception", "fatal", "✗", "panic", "traceback"];
const WARN_PATTERNS = ["warning", "warn", "deprecat"];

/**
 * Pure classifier for one structured daemon log entry. `stderr` is always `error`; `exit` is `exit`
 * when the code is 0 (or unknown) and `error` when non-zero; `meta` is `info`. `stdout` is keyword-
 * sniffed (error wins over warn). No I/O, no Date — covered by bun:test in isolation. This is the
 * unit-testable core the SSE tail and the mobile viewer both rely on for highlighting.
 */
export function classifyLogLine(entry: LogEntry): LogLineClass {
    if (entry.type === "meta") {
        return "info";
    }

    if (entry.type === "exit") {
        return entry.code != null && entry.code !== 0 ? "error" : "exit";
    }

    if (entry.type === "stderr") {
        return "error";
    }

    const lower = entry.data.toLowerCase();
    if (ERROR_PATTERNS.some((p) => lower.includes(p))) {
        return "error";
    }

    if (WARN_PATTERNS.some((p) => lower.includes(p))) {
        return "warn";
    }

    return "info";
}
