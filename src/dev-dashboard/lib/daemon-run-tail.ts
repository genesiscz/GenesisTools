import { isAbsolute, relative, resolve } from "node:path";
import { getLogsBaseDir } from "@app/daemon/lib/config";
import type { LogEntry } from "@app/daemon/lib/types";
import { FileTailer } from "@app/utils/fs/file-tailer";

/**
 * Contain `logFile` to the daemon logs dir so a crafted `?logFile=` can't read arbitrary files.
 * Extracted from `getRunLog` (aggregator.ts) so the static log fetch AND the live SSE tail share ONE
 * guard (root-fix, not two copies). Returns the resolved absolute path; throws on escape.
 */
export function assertLogFileContained(logFile: string, baseDir: string = getLogsBaseDir()): string {
    const root = resolve(baseDir);
    const resolved = resolve(logFile);
    const rel = relative(root, resolved);

    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error("logFile escapes the daemon logs directory");
    }

    return resolved;
}

export interface RunLogTail {
    close(): void;
}

/**
 * Tail a daemon run's JSONL log, emitting each newly-appended `LogEntry`. Mirrors `createQaStream`
 * (qa-sse.ts) — a thin `FileTailer` wrapper. The path is containment-checked first. `FileTailer` does
 * NOT replay pre-existing lines (offset starts at current size), so this is a true "from now on" tail;
 * the screen seeds the backlog separately via the static `getRunLog` fetch.
 */
export function createRunLogTail(
    logFile: string,
    onEntry: (e: LogEntry) => void,
    baseDir: string = getLogsBaseDir()
): RunLogTail {
    const resolved = assertLogFileContained(logFile, baseDir);
    const t = new FileTailer<LogEntry>(resolved, { onLine: (e) => onEntry(e) });
    t.start();
    return { close: () => t.stop() };
}
