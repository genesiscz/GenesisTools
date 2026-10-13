import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { parseInterval } from "./interval";
import { timeOnDay } from "./missed-run";
import { isValidTaskName } from "./run-log-name";
import {
    type DaemonConfig,
    type DaemonTask,
    MISSED_RUN_MODES,
    type MissedRunPolicy,
    TASK_PRIORITIES,
    type TaskPriority,
} from "./types";

// Resolved lazily per call — a module-level instance captures the storage
// base dir at import time, which bypasses GENESIS_TOOLS_HOME overrides set
// later (the per-file test sandbox trips its real-path guard exactly this
// way when another test file imported us first).
function getStorage(): Storage {
    return new Storage("daemon");
}

function resolveBaseDir(): string {
    const override = env.getTrimmed("GENESIS_TOOLS_DAEMON_DIR");

    if (override) {
        return override;
    }

    return join(env.tools.getHome(), ".genesis-tools", "daemon");
}

export function getLogsBaseDir(): string {
    return join(resolveBaseDir(), "logs");
}

export function getPidFile(): string {
    return join(resolveBaseDir(), "daemon.pid");
}

export async function ensureStorage(): Promise<void> {
    await getStorage().ensureDirs();
    mkdirSync(getLogsBaseDir(), { recursive: true });
}

/** The tasks a hand-edited config may hold: a valid name (the rule registerTask enforces) and a parsable interval. */
export function validateTasks(tasks: DaemonTask[]): DaemonTask[] {
    return tasks.filter((task) => {
        if (!isValidTaskName(task.name)) {
            logger.warn({ task: task.name }, '[daemon] invalid task name in config (empty, or with "/", "\\" or "..")');
            return false;
        }

        try {
            parseInterval(task.every);
            return true;
        } catch (err) {
            logger.warn({ err, task: task.name, every: task.every }, "[daemon] invalid task interval in config");
            return false;
        }
    });
}

export async function loadConfig(): Promise<DaemonConfig> {
    const config = await getStorage().getConfig<DaemonConfig>();

    if (!config || !Array.isArray(config.tasks)) {
        return { tasks: [] };
    }

    return { ...config, tasks: validateTasks(config.tasks) };
}

export async function getTask(name: string): Promise<DaemonTask | undefined> {
    const config = await loadConfig();
    return config.tasks.find((t) => t.name === name);
}

export async function upsertTask(task: DaemonTask): Promise<void> {
    await getStorage().atomicConfigUpdate<DaemonConfig>((config) => {
        if (!Array.isArray(config.tasks)) {
            config.tasks = [];
        }

        const idx = config.tasks.findIndex((t) => t.name === task.name);

        if (idx >= 0) {
            config.tasks[idx] = task;
        } else {
            config.tasks.push(task);
        }
    });
}

export async function removeTask(name: string): Promise<boolean> {
    let removed = false;

    await getStorage().atomicConfigUpdate<DaemonConfig>((config) => {
        if (!Array.isArray(config.tasks)) {
            config.tasks = [];
            return;
        }

        const before = config.tasks.length;
        config.tasks = config.tasks.filter((t) => t.name !== name);
        removed = config.tasks.length !== before;
    });

    return removed;
}

export async function setTaskEnabled(name: string, enabled: boolean): Promise<void> {
    await getStorage().atomicConfigUpdate<DaemonConfig>((config) => {
        const task = config.tasks?.find((t) => t.name === name);

        if (!task) {
            throw new Error(`Task "${name}" not found`);
        }

        task.enabled = enabled;
    });
}

/** The task config file (`~/.genesis-tools/daemon/config.json`). */
export function getConfigPath(): string {
    return getStorage().getConfigPath();
}

/** The fields `tools daemon config set` (and the Daemon pane through it) may change. `null` clears a field back to
 *  its default. */
export interface TaskPatch {
    every?: string;
    timeoutMs?: number | null;
    retries?: number;
    enabled?: boolean;
    notify?: boolean | "failure";
    priority?: TaskPriority | null;
    missedRun?: MissedRunPolicy | null;
    description?: string;
}

/** Every reason the patch cannot be applied, as sentences; empty when it can. */
export function validateTaskPatch(patch: TaskPatch): string[] {
    const errors: string[] = [];

    if (patch.every !== undefined) {
        try {
            parseInterval(patch.every);
        } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
        }
    }

    if (patch.timeoutMs !== undefined && patch.timeoutMs !== null) {
        if (!Number.isInteger(patch.timeoutMs) || patch.timeoutMs < 1_000) {
            errors.push(`timeoutMs must be a whole number of milliseconds, at least 1000; got ${patch.timeoutMs}`);
        }
    }

    if (patch.retries !== undefined && (!Number.isInteger(patch.retries) || patch.retries < 0 || patch.retries > 10)) {
        errors.push(`retries must be a whole number from 0 to 10; got ${patch.retries}`);
    }

    if (patch.priority !== undefined && patch.priority !== null && !TASK_PRIORITIES.includes(patch.priority)) {
        errors.push(`priority must be one of ${TASK_PRIORITIES.join(", ")}; got ${patch.priority}`);
    }

    const missed = patch.missedRun;
    if (missed !== undefined && missed !== null) {
        if (!MISSED_RUN_MODES.includes(missed.mode)) {
            errors.push(`missedRun.mode must be one of ${MISSED_RUN_MODES.join(", ")}; got ${missed.mode}`);
        }

        if (missed.mode === "retry-at") {
            const times = missed.times ?? [];
            if (times.length === 0) {
                errors.push("retry-at needs at least one time, such as 10:00,12:00");
            }

            for (const time of times) {
                if (timeOnDay(time, new Date()) === null) {
                    errors.push(`retry-at time must be HH:MM (24 h); got "${time}"`);
                }
            }
        }
    }

    return errors;
}

function applyPatch(task: DaemonTask, patch: TaskPatch): void {
    if (patch.every !== undefined) {
        task.every = patch.every;
    }

    if (patch.timeoutMs !== undefined) {
        if (patch.timeoutMs === null) {
            delete task.timeoutMs;
        } else {
            task.timeoutMs = patch.timeoutMs;
        }
    }

    if (patch.retries !== undefined) {
        task.retries = patch.retries;
    }

    if (patch.enabled !== undefined) {
        task.enabled = patch.enabled;
    }

    if (patch.notify !== undefined) {
        task.notify = patch.notify;
    }

    if (patch.priority !== undefined) {
        // An explicit "normal" is stored, so a tool that registers the task again with a low default keeps it.
        if (patch.priority === null) {
            delete task.priority;
        } else {
            task.priority = patch.priority;
        }
    }

    if (patch.missedRun !== undefined) {
        if (patch.missedRun === null || patch.missedRun.mode === "asap") {
            delete task.missedRun;
        } else {
            task.missedRun =
                patch.missedRun.mode === "retry-at"
                    ? { mode: "retry-at", times: (patch.missedRun.times ?? []).map((t) => t.trim()) }
                    : { mode: patch.missedRun.mode };
        }
    }

    if (patch.description !== undefined) {
        task.description = patch.description;
    }
}

/**
 * Changes one task's fields in one atomic config update, after validating them. The running daemon re-reads the
 * config every tick, so a change takes effect on its next tick without a restart. Throws on an unknown task or an
 * invalid field, and then writes nothing.
 */
export async function updateTask(name: string, patch: TaskPatch): Promise<DaemonTask> {
    const errors = validateTaskPatch(patch);
    if (errors.length > 0) {
        throw new Error(errors.join("; "));
    }

    let updated: DaemonTask | undefined;
    await getStorage().atomicConfigUpdate<DaemonConfig>((config) => {
        const task = config.tasks?.find((t) => t.name === name);

        if (!task) {
            throw new Error(`Task "${name}" not found`);
        }

        applyPatch(task, patch);
        updated = { ...task };
    });

    if (!updated) {
        throw new Error(`Task "${name}" not found`);
    }

    logger.info({ task: name, patch }, "[daemon] task updated");
    return updated;
}
