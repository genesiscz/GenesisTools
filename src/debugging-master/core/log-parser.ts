import type { IndexedLogEntry, LogEntry, LogLevel, SessionStats, TimerPair } from "@app/debugging-master/types";

export function indexEntries(entries: LogEntry[]): IndexedLogEntry[] {
    return entries.map((e, i) => ({ ...e, index: i + 1 }));
}

export function filterByLevel(entries: IndexedLogEntry[], levels: string[]): IndexedLogEntry[] {
    const levelSet = new Set<string>(levels);
    levelSet.add("raw");
    return entries.filter((e) => levelSet.has(e.level));
}

export function filterByHypothesis(entries: IndexedLogEntry[], h: string): IndexedLogEntry[] {
    return entries.filter((e) => e.h === h || e.level === "raw");
}

export function lastN(entries: IndexedLogEntry[], n: number): IndexedLogEntry[] {
    return entries.slice(-n);
}

export function computeTimerPairs(entries: IndexedLogEntry[]): TimerPair[] {
    const starts: Record<string, { ts: number; index: number }> = {};
    const pairs: TimerPair[] = [];

    for (const e of entries) {
        if (e.level === "timer-start" && e.label) {
            starts[e.label] = { ts: e.ts, index: e.index };
        } else if (e.level === "timer-end" && e.label) {
            const start = starts[e.label];
            if (start) {
                pairs.push({
                    label: e.label,
                    startTs: start.ts,
                    endTs: e.ts,
                    durationMs: e.durationMs ?? e.ts - start.ts,
                    startIndex: start.index,
                    endIndex: e.index,
                });
                delete starts[e.label];
            }
        }
    }
    return pairs;
}

export function computeStats(entries: IndexedLogEntry[]): SessionStats {
    const levelCounts: Record<string, number> = {};
    let assertsPassed = 0;
    let assertsFailed = 0;
    const files = new Set<string>();

    for (const e of entries) {
        levelCounts[e.level] = (levelCounts[e.level] ?? 0) + 1;
        if (e.level === "assert") {
            if (e.passed) {
                assertsPassed++;
            } else {
                assertsFailed++;
            }
        }
        if (e.file) {
            files.add(e.file);
        }
    }

    const timerPairs = computeTimerPairs(entries);
    const avgTimerMs =
        timerPairs.length > 0 ? timerPairs.reduce((sum, p) => sum + p.durationMs, 0) / timerPairs.length : 0;

    const timestamps = entries.filter((e) => e.ts).map((e) => e.ts);
    let startTime = 0;
    let endTime = 0;
    if (timestamps.length > 0) {
        startTime = timestamps.reduce((a, b) => (a < b ? a : b));
        endTime = timestamps.reduce((a, b) => (a > b ? a : b));
    }

    return {
        entryCount: entries.length,
        levelCounts,
        timerPairs,
        avgTimerMs,
        assertsPassed,
        assertsFailed,
        startTime: Number.isFinite(startTime) ? startTime : 0,
        endTime: Number.isFinite(endTime) ? endTime : 0,
        spanMs: Number.isFinite(endTime - startTime) ? endTime - startTime : 0,
        files: [...files],
    };
}

export function mergeTimerEntries(entries: IndexedLogEntry[]): IndexedLogEntry[] {
    const pairs = computeTimerPairs(entries);
    const endIndices = new Set(pairs.map((p) => p.endIndex));
    const startToEnd = new Map(pairs.map((p) => [p.startIndex, p]));

    const result: IndexedLogEntry[] = [];
    for (const e of entries) {
        if (endIndices.has(e.index)) {
            continue;
        }
        if (startToEnd.has(e.index)) {
            const pair = startToEnd.get(e.index)!;
            result.push({
                ...e,
                level: "timer-end" as LogLevel,
                durationMs: pair.durationMs,
            });
        } else if (e.level !== "timer-start" && e.level !== "timer-end") {
            result.push(e);
        }
    }
    return result;
}
