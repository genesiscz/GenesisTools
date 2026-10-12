/** The folder under the logs base dir that holds a task's run logs; a name with a path separator stays inside it. */
export function taskLogDirName(name: string): string {
    return name.replace(/[/\\]/g, "_") || "unnamed-task";
}

/**
 * A run log's name, `<local stamp>-<runId>.jsonl` as the runner writes it, e.g. 2026-05-15T19-02-16-a8a9c339.jsonl.
 * The stamp is local time without a zone (`formatLocalFileTimestamp`); the groups are its date, hour, minute, second.
 */
export const RUN_LOG_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-[A-Za-z0-9_-]+\.jsonl$/;
