import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Storage } from "@app/utils/storage/storage";
import type { DaemonConfig, DaemonTask } from "./types";

const storage = new Storage("daemon");

const BASE_DIR = join(homedir(), ".genesis-tools", "daemon");
const LOGS_DIR = join(BASE_DIR, "logs");
const PID_FILE = join(BASE_DIR, "daemon.pid");

export function getLogsBaseDir(): string {
    return LOGS_DIR;
}

export function getPidFile(): string {
    return PID_FILE;
}

export async function ensureStorage(): Promise<void> {
    await storage.ensureDirs();
    mkdirSync(LOGS_DIR, { recursive: true });
}

export async function loadConfig(): Promise<DaemonConfig> {
    const config = await storage.getConfig<DaemonConfig>();

    if (!config || !Array.isArray(config.tasks)) {
        return { tasks: [] };
    }

    return config;
}

export async function saveConfig(config: DaemonConfig): Promise<void> {
    await storage.setConfig(config);
}

export async function getTask(name: string): Promise<DaemonTask | undefined> {
    const config = await loadConfig();
    return config.tasks.find((t) => t.name === name);
}

export async function upsertTask(task: DaemonTask): Promise<void> {
    const config = await loadConfig();
    const idx = config.tasks.findIndex((t) => t.name === task.name);

    if (idx >= 0) {
        config.tasks[idx] = task;
    } else {
        config.tasks.push(task);
    }

    await saveConfig(config);
}

export async function removeTask(name: string): Promise<boolean> {
    const config = await loadConfig();
    const before = config.tasks.length;
    config.tasks = config.tasks.filter((t) => t.name !== name);

    if (config.tasks.length === before) {
        return false;
    }

    await saveConfig(config);
    return true;
}

export async function setTaskEnabled(name: string, enabled: boolean): Promise<void> {
    const config = await loadConfig();
    const task = config.tasks.find((t) => t.name === name);

    if (!task) {
        throw new Error(`Task "${name}" not found`);
    }

    task.enabled = enabled;
    await saveConfig(config);
}
