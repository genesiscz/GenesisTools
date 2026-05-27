import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@app/utils/json";

export interface TaskToolConfig {
    sessionRetentionDays: number;
    gcOnRunStart: boolean;
}

const DEFAULT: TaskToolConfig = {
    sessionRetentionDays: 30,
    gcOnRunStart: true,
};

export function configPath(): string {
    return process.env.TASK_CONFIG_PATH ?? join(homedir(), ".genesis-tools", "task", "config.json");
}

export function loadTaskToolConfig(path = configPath()): TaskToolConfig {
    if (!existsSync(path)) {
        return DEFAULT;
    }

    try {
        return { ...DEFAULT, ...(SafeJSON.parse(readFileSync(path, "utf8")) as Partial<TaskToolConfig>) };
    } catch {
        return DEFAULT;
    }
}

export function saveTaskToolConfig(patch: Partial<TaskToolConfig>, path = configPath()): TaskToolConfig {
    const next = { ...loadTaskToolConfig(path), ...patch };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SafeJSON.stringify(next, null, 2));
    return next;
}
