import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { z } from "zod";
import type { AnyActionDef, AreaDef } from "./define";

/**
 * `~/.genesis-tools/genesis-tools/config.json`: what the person chose, per area and per action. Only changed keys are
 * stored; a resolved config is the schema defaults, then the area's values, then the action's.
 */

export interface AreaConfigValues {
    actions?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
}

export interface GenesisToolsConfigFile {
    version: 1;
    areas: Record<string, AreaConfigValues>;
}

export interface ConfigChange {
    path: string;
    value: unknown;
}

export interface ConfigStore {
    read(): GenesisToolsConfigFile;
    /** Defaults, then the area's stored values, then the action's. */
    resolve(area: string, action?: string): Record<string, unknown>;
    /** `<area>.<key>` or `<area>.<action>.<key>`; the resolved value. */
    get(path: string): unknown;
    set(path: string, value: unknown): Promise<void>;
    unset(path: string): Promise<void>;
    onChange(listener: (change: ConfigChange) => void): () => void;
}

// biome-ignore lint/suspicious/noExplicitAny: the config store reads the schemas of areas of every type.
type AnyArea = AreaDef<string, Record<string, AnyActionDef>, any>;

export function genesisToolsConfigPath(): string {
    return toolDataDir("genesis-tools", "config.json");
}

function emptyConfigFile(): GenesisToolsConfigFile {
    return { version: 1, areas: {} };
}

/** The defaults a config schema gives an empty object. */
export function schemaDefaults(schema: z.ZodObject | undefined): Record<string, unknown> {
    if (!schema) {
        return {};
    }

    const parsed = schema.safeParse({});
    return parsed.success ? { ...parsed.data } : {};
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

interface ConfigTarget {
    area: string;
    action: string | null;
    key: string;
    schema: z.ZodType;
}

/** Resolves `<area>.<key>` or `<area>.<action>.<key>` to the schema that owns the key, or throws naming the keys. */
export function configTarget(registry: Record<string, AnyArea>, path: string): ConfigTarget {
    const parts = path.split(".");
    const areaDef = registry[parts[0] ?? ""];

    if (!areaDef) {
        throw new ConfigError(`no area "${parts[0]}"; areas: ${Object.keys(registry).join(", ")}`);
    }

    if (parts.length === 2) {
        const key = parts[1] ?? "";
        const schema = areaDef.config?.shape[key];

        if (!schema) {
            throw new ConfigError(`area ${areaDef.area} has no config key "${key}"; keys: ${keysOf(areaDef.config)}`);
        }

        return { area: areaDef.area, action: null, key, schema };
    }

    if (parts.length === 3) {
        const [, action = "", key = ""] = parts;
        const actionDef = areaDef.actions[action];

        if (!actionDef) {
            throw new ConfigError(`area ${areaDef.area} has no action "${action}"`);
        }

        const schema = actionDef.config?.shape[key] ?? areaDef.config?.shape[key];

        if (!schema) {
            throw new ConfigError(
                `${areaDef.area}.${action} has no config key "${key}"; keys: ${keysOf(actionDef.config)} (area: ${keysOf(areaDef.config)})`
            );
        }

        return { area: areaDef.area, action, key, schema };
    }

    throw new ConfigError(`"${path}" is not <area>.<key> or <area>.<action>.<key>`);
}

function keysOf(schema: z.ZodObject | undefined): string {
    const keys = Object.keys(schema?.shape ?? {});
    return keys.length > 0 ? keys.join(", ") : "none";
}

/** Reads a config file's text; a value that is not an object of objects is dropped and logged. */
export function parseConfigText(text: string): GenesisToolsConfigFile {
    const raw: unknown = SafeJSON.parse(text);

    if (!isObject(raw) || (raw.version !== undefined && raw.version !== 1)) {
        throw new ConfigError("config.json is not a version 1 GenesisTools config");
    }

    const areas: GenesisToolsConfigFile["areas"] = {};

    for (const [area, values] of Object.entries(isObject(raw.areas) ? raw.areas : {})) {
        if (!isObject(values)) {
            logger.warn({ area }, "genesis-tools config: an area's values are not an object, ignored");
            continue;
        }

        areas[area] = values;
    }

    return { version: 1, areas };
}

/** The pure resolution: defaults (area, then action), then stored area values, then stored action values. */
export function resolveConfig(
    file: GenesisToolsConfigFile,
    areaDef: AnyArea,
    action?: string
): Record<string, unknown> {
    const { actions: storedActions, ...storedArea } = file.areas[areaDef.area] ?? {};
    const actionDef = action ? areaDef.actions[action] : undefined;

    return {
        ...schemaDefaults(areaDef.config),
        ...schemaDefaults(actionDef?.config),
        ...storedArea,
        ...(action && isObject(storedActions) ? (storedActions[action] ?? {}) : {}),
    };
}

function withKey(file: GenesisToolsConfigFile, target: ConfigTarget, value: unknown): GenesisToolsConfigFile {
    const areaValues: AreaConfigValues = { ...(file.areas[target.area] ?? {}) };

    if (target.action === null) {
        if (value === undefined) {
            delete areaValues[target.key];
        } else {
            areaValues[target.key] = value;
        }
    } else {
        const actions = { ...(areaValues.actions ?? {}) };
        const actionValues = { ...(actions[target.action] ?? {}) };

        if (value === undefined) {
            delete actionValues[target.key];
        } else {
            actionValues[target.key] = value;
        }

        actions[target.action] = actionValues;
        areaValues.actions = actions;
    }

    return { version: 1, areas: { ...file.areas, [target.area]: areaValues } };
}

export interface ConfigStoreOptions {
    registry: Record<string, AnyArea>;
    file?: string;
}

/** The one writer of config.json: a set is a locked read, schema check, merge and write, then a `config.changed`. */
export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
    const file = options.file ?? genesisToolsConfigPath();
    const listeners = new Set<(change: ConfigChange) => void>();

    function read(): GenesisToolsConfigFile {
        if (!existsSync(file)) {
            return emptyConfigFile();
        }

        return parseConfigText(readFileSync(file, "utf8"));
    }

    /** A run reads through this: a broken file gives the defaults and a warning, while a set refuses to overwrite it. */
    function readOrDefaults(): GenesisToolsConfigFile {
        try {
            return read();
        } catch (error) {
            logger.warn({ error, file }, "genesis-tools config: unreadable, running with the defaults");
            return emptyConfigFile();
        }
    }

    async function write(path: string, value: unknown): Promise<void> {
        const target = configTarget(options.registry, path);
        let stored = value;

        if (value !== undefined) {
            const parsed = target.schema.safeParse(value);

            if (!parsed.success) {
                throw new ConfigError(`${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
            }

            stored = parsed.data;
        }

        mkdirSync(dirname(file), { recursive: true });
        await withFileLock(`${file}.lock`, async () => {
            writeFileSync(file, `${SafeJSON.stringify(withKey(read(), target, stored), null, 4)}\n`);
        });

        // The value is written; a listener that throws must not tell the caller the set failed.
        for (const listener of listeners) {
            try {
                listener({ path, value: stored });
            } catch (error) {
                logger.warn({ error, path }, "genesis-tools config: a change listener threw");
            }
        }
    }

    function resolve(area: string, action?: string): Record<string, unknown> {
        const areaDef = options.registry[area];

        if (!areaDef) {
            throw new ConfigError(`no area "${area}"`);
        }

        return resolveConfig(readOrDefaults(), areaDef, action);
    }

    return {
        read,
        resolve,
        get(path) {
            const target = configTarget(options.registry, path);
            return resolve(target.area, target.action ?? undefined)[target.key];
        },
        set: (path, value) => write(path, value),
        unset: (path) => write(path, undefined),
        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
