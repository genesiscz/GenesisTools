import type { LogEntry, RunSummary } from "@dd/contract";

/**
 * Pure formatters for the daemon screen. Reimplemented locally (NOT imported from `@app/*`) so the
 * RN bundle never drags web/server code in. Pure logic + `Date` only — runs under `bun:test`.
 */

export const DASH = "—";

export type RunOutcome = "running" | "ok" | "failed";

/** Classify a run by its exit code (null = still running). */
export function runOutcome(run: Pick<RunSummary, "exitCode">): RunOutcome {
    if (run.exitCode === null) {
        return "running";
    }

    return run.exitCode === 0 ? "ok" : "failed";
}

/** Milliseconds → a compact human duration (e.g. `940ms`, `3.2s`, `1m04s`); null → em dash. */
export function duration(ms: number | null): string {
    if (ms === null || Number.isNaN(ms)) {
        return DASH;
    }

    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }

    const seconds = ms / 1000;
    if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
    }

    const mins = Math.floor(seconds / 60);
    const rem = Math.round(seconds % 60);
    return `${mins}m${String(rem).padStart(2, "0")}s`;
}

/** ISO string → local short date+time (e.g. `May 30, 14:05`); null/invalid → em dash. */
export function startedAt(iso: string | null): string {
    if (!iso) {
        return DASH;
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return DASH;
    }

    return new Intl.DateTimeFormat("en-GB", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(date);
}

/** A flat one-line string for a structured log entry (used by the log viewer). */
export function logLineText(entry: LogEntry): string {
    if (entry.type === "meta") {
        return `▶ ${entry.taskName} (attempt ${entry.attempt}) — ${entry.command}`;
    }

    if (entry.type === "exit") {
        const code = entry.code === null ? "?" : entry.code;
        const timedOut = entry.timedOut ? " (timed out)" : "";
        return `■ exit ${code} in ${duration(entry.duration_ms)}${timedOut}`;
    }

    return entry.data.replace(/\n+$/, "");
}
