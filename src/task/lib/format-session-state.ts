import type { TaskSessionMeta } from "@app/task/types";

function formatDurationMs(ms: number): string {
    const seconds = Math.round(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;

    if (mins > 0) {
        return `${mins}m ${secs}s`;
    }

    return `${secs}s`;
}

export function formatSessionState(meta: TaskSessionMeta | null): string {
    if (!meta) {
        return "unknown";
    }

    if (meta.exitCode !== undefined) {
        return `exited (code ${meta.exitCode}, ${formatDurationMs(meta.durationMs ?? 0)})`;
    }

    const runningMs = Date.now() - meta.createdAt;
    return `active (running ${formatDurationMs(runningMs)})`;
}
