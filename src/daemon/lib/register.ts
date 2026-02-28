import { ensureStorage, getTask, removeTask, upsertTask } from "./config";
import { parseInterval } from "./interval";
import type { DaemonTask } from "./types";

export interface RegisterTaskOptions {
    name: string;
    command: string;
    every: string;
    retries?: number;
    enabled?: boolean;
    description?: string;
    overwrite?: boolean;
}

function validateTaskName(name: string): void {
    if (!name || /[/\\]|\.\./.test(name)) {
        throw new Error(`Invalid task name "${name}". Must not contain "/", "\\", or "..".`);
    }
}

export async function registerTask(opts: RegisterTaskOptions): Promise<boolean> {
    validateTaskName(opts.name);
    parseInterval(opts.every);
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
    };

    await upsertTask(task);
    return true;
}

export async function unregisterTask(name: string): Promise<boolean> {
    await ensureStorage();
    return removeTask(name);
}

export async function isTaskRegistered(name: string): Promise<boolean> {
    await ensureStorage();
    const task = await getTask(name);
    return task !== undefined;
}
