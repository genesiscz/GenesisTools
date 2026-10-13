import { ensureStorage, getTask, removeTask, upsertTask } from "./config";
import { parseInterval } from "./interval";
import { isValidTaskName } from "./run-log-name";
import type { DaemonTask, RunLogRetention, TaskPriority } from "./types";

export const DEFAULT_RETENTION: RunLogRetention = { maxAgeDays: 14, minRuns: 50 };

export interface RegisterTaskOptions {
    name: string;
    command: string;
    every: string;
    retries?: number;
    enabled?: boolean;
    description?: string;
    timeoutMs?: number;
    overwrite?: boolean;
    /** Send macOS notifications on start/complete/fail. Default: true. `"failure"`: only when it fails. */
    notify?: boolean | "failure";
    /** Optional run-log retention; daemon prunes post-run. */
    retention?: RunLogRetention;
    /** The task's default priority. A priority already stored (set by the user) wins on re-registration. */
    priority?: TaskPriority;
}

function validateTaskName(name: string): void {
    if (!isValidTaskName(name)) {
        throw new Error(`Invalid task name "${name}". Must not contain "/", "\\", or "..".`);
    }
}

export async function registerTask(opts: RegisterTaskOptions): Promise<boolean> {
    validateTaskName(opts.name);
    parseInterval(opts.every);

    if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
        throw new Error(`Invalid timeoutMs "${String(opts.timeoutMs)}". Must be a finite number greater than 0.`);
    }

    await ensureStorage();

    const existing = await getTask(opts.name);

    if (existing && !opts.overwrite) {
        return false;
    }

    const task: DaemonTask = {
        name: opts.name,
        command: opts.command,
        every: opts.every,
        retries: opts.retries ?? 3,
        enabled: opts.enabled ?? true,
        description: opts.description,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.notify === false || opts.notify === "failure" ? { notify: opts.notify } : {}),
        retention: opts.retention ?? DEFAULT_RETENTION,
        // Set by the user (tools daemon config set, the Daemon pane); a tool re-registering its task keeps them.
        ...(existing?.priority
            ? { priority: existing.priority }
            : opts.priority && opts.priority !== "normal"
              ? { priority: opts.priority }
              : {}),
        ...(existing?.missedRun ? { missedRun: existing.missedRun } : {}),
    };

    await upsertTask(task);
    return true;
}

export async function unregisterTask(name: string): Promise<boolean> {
    await ensureStorage();
    return removeTask(name);
}

/** A read: a missing config means no task, and nothing is created (status commands call this). */
export async function isTaskRegistered(name: string): Promise<boolean> {
    const task = await getTask(name);
    return task !== undefined;
}
