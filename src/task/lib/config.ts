import { existsSync, readFileSync } from "node:fs";
import { taskConfigPath } from "@app/task/lib/paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, isJsonObject } from "@genesiscz/utils/storage/atomic-file";
import { Storage } from "@genesiscz/utils/storage/storage";

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

/**
 * The whole config object on disk, every key kept: `Storage("task")` keeps `recentSession` in the same file.
 * Only a missing file is empty. A file that exists but cannot be read or does not parse throws.
 */
function readRawTaskConfig(path: string): Record<string, unknown> {
    if (!existsSync(path)) {
        return {};
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(`Invalid task config at ${path}: it cannot be read or does not parse, left untouched`, {
            cause: error,
        });
    }

    if (!isJsonObject(parsed)) {
        throw new Error(`Invalid task config at ${path}: expected a JSON object, left untouched`);
    }

    return parsed;
}

export function loadTaskToolConfig(path = configPath()): TaskToolConfig {
    try {
        const raw = readRawTaskConfig(path);
        const normalized = normalizeTaskToolConfig(raw);

        for (const key of ["sessionRetentionDays", "gcOnRunStart"] as const) {
            if (Object.hasOwn(raw, key) && normalized[key] === undefined) {
                throw new Error(`Invalid task config at ${path}: invalid ${key}, left untouched`);
            }
        }

        return { ...DEFAULT, ...normalized };
    } catch (err) {
        // The retention the user set is unknown, so the run-start GC must not delete sessions by the default.
        logger.warn({ err, path }, "task config: failed to load; using defaults with run-start GC off");

        return { ...DEFAULT, gcOnRunStart: false };
    }
}

/**
 * Merge a patch into the config file under the lock `Storage("task").atomicConfigUpdate` takes, so a
 * concurrent `recentSession` write is not lost. Refuses an existing file that does not parse.
 */
export async function saveTaskToolConfig(patch: Partial<TaskToolConfig>, path = configPath()): Promise<TaskToolConfig> {
    return new Storage("task").withFileLock({
        file: path,
        fn: async () => {
            const next = { ...readRawTaskConfig(path), ...patch };
            atomicWriteFileSync(path, SafeJSON.stringify(next, null, 2));

            return { ...DEFAULT, ...normalizeTaskToolConfig(next) };
        },
    });
}
