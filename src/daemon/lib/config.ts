import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { Storage } from "@app/utils/storage/storage";
import { parseInterval } from "./interval";
import type { DaemonConfig, DaemonTask } from "./types";

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

export function validateTaskIntervals(tasks: DaemonTask[]): DaemonTask[] {
    return tasks.filter((task) => {
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

    return { ...config, tasks: validateTaskIntervals(config.tasks) };
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
