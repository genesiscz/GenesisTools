import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "@app/logger";
import { taskConfigPath } from "@app/task/lib/paths";
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
    return taskConfigPath();
}

function normalizeTaskToolConfig(input: unknown): Partial<TaskToolConfig> {
    if (!input || typeof input !== "object") {
        return {};
    }

    const obj = input as Record<string, unknown>;
    const out: Partial<TaskToolConfig> = {};

    if (
        typeof obj.sessionRetentionDays === "number" &&
        Number.isFinite(obj.sessionRetentionDays) &&
        obj.sessionRetentionDays >= 0
    ) {
        out.sessionRetentionDays = obj.sessionRetentionDays;
    }

    if (typeof obj.gcOnRunStart === "boolean") {
        out.gcOnRunStart = obj.gcOnRunStart;
    }

    return out;
}

export function loadTaskToolConfig(path = configPath()): TaskToolConfig {
    if (!existsSync(path)) {
        return DEFAULT;
    }

    try {
        return { ...DEFAULT, ...normalizeTaskToolConfig(SafeJSON.parse(readFileSync(path, "utf8"))) };
    } catch (err) {
        logger.warn({ err, path }, "task config: failed to load; falling back to defaults");

        return DEFAULT;
    }
}

export function saveTaskToolConfig(patch: Partial<TaskToolConfig>, path = configPath()): TaskToolConfig {
    const next = { ...loadTaskToolConfig(path), ...patch };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SafeJSON.stringify(next, null, 2));

    return next;
}
