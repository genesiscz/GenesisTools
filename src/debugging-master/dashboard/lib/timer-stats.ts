import type { IndexedLogEntry } from "@app/debugging-master/types";

export interface TimerStats {
    label: string;
    count: number;
    totalMs: number;
    meanMs: number;
    minMs: number;
    maxMs: number;
    lastMs: number;
    p50Ms: number;
    p95Ms: number;
}

/**
 * Aggregate stats for all prior `timer-end` entries with this label, up to
 * and including `atIndex`. Returns null if no completed timers exist yet.
 */
export function computeTimerStats(entries: IndexedLogEntry[], label: string, atIndex: number): TimerStats | null {
    const durations: number[] = [];
    for (const e of entries) {
        if (e.index > atIndex) {
            break;
        }
        if (e.level === "timer-end" && e.label === label && typeof e.durationMs === "number") {
            durations.push(e.durationMs);
        }
    }
    if (durations.length === 0) {
        return null;
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const total = durations.reduce((s, d) => s + d, 0);
    const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

    return {
        label,
        count: durations.length,
        totalMs: total,
        meanMs: total / durations.length,
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
        lastMs: durations[durations.length - 1],
        p50Ms: p(0.5),
        p95Ms: p(0.95),
    };
}
