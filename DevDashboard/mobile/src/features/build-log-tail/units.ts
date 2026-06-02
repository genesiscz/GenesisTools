import type { ClassifiedLogEntry, LogLineClass } from "@dd/contract";
import { classifyLogLine } from "@dd/lib/daemon-view/classify";
import type { ClassifiedLine } from "@/features/build-log-tail/types";

/**
 * Pure, render-free helpers for the build-log viewer (mirrors daemon/units.ts + qa/live-feed.ts).
 * Covered by bun:test without a renderer. NOTE the classifier import: `classifyLogLine` lives in the
 * shared dev-dashboard lib (`@dd/lib/daemon-view/classify`); we import the TYPE-light pure function so
 * the mock/backlog path (entries without a server `cls`) can still be classified client-side. It's
 * pure (no I/O), safe in the RN bundle.
 */

const DASH = "—";

function duration(ms: number | null | undefined): string {
    if (ms == null || Number.isNaN(ms)) {
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

/** One-line display string for an entry (mirrors daemon `logLineText`, reimplemented local to RN). */
export function lineText(entry: ClassifiedLogEntry): string {
    if (entry.type === "meta") {
        return `▶ ${entry.taskName} (attempt ${entry.attempt}) — ${entry.command}`;
    }

    if (entry.type === "exit") {
        const code = entry.code == null ? "?" : entry.code;
        const timedOut = entry.timedOut ? " (timed out)" : "";
        return `■ exit ${code} in ${duration(entry.duration_ms)}${timedOut}`;
    }

    return entry.data.replace(/\n+$/, "");
}

/** Effective class — trust the server `cls`, fall back to the pure classifier (mock/old payloads). */
function classOf(entry: ClassifiedLogEntry): LogLineClass {
    return entry.cls ?? classifyLogLine(entry);
}

/** Map a list of entries to indexed, render-ready lines. */
export function toClassifiedLines(entries: ClassifiedLogEntry[]): ClassifiedLine[] {
    return entries.map((entry, index) => ({ index, cls: classOf(entry), text: lineText(entry), entry }));
}

/** Index of the first error-classified line, or -1. */
export function firstErrorIndex(lines: ClassifiedLine[]): number {
    return lines.findIndex((l) => l.cls === "error");
}

/** How many lines are error-classified. */
export function errorCount(lines: ClassifiedLine[]): number {
    return lines.reduce((n, l) => (l.cls === "error" ? n + 1 : n), 0);
}
