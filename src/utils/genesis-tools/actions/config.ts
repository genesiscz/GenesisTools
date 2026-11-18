import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { jsonDocument } from "@genesiscz/utils/storage/locked-document";
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
    return decodeConfigFile(SafeJSON.parse(text));
}

/** The config file from its parsed JSON; another version throws, an area that is not an object is dropped. */
function decodeConfigFile(raw: unknown): GenesisToolsConfigFile {
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

/**
 * The stored values their schema accepts, as the schema parses them. The file can be edited by hand or written under an
 * older schema, so a value the schema refuses keeps its default (with a warning) and an unknown key is left out.
 */
function checkedValues(
    values: Record<string, unknown>,
    schemaOf: (key: string) => z.ZodType | undefined,
    owner: string
): Record<string, unknown> {
    const checked: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(values)) {
        const schema = schemaOf(key);

        if (!schema) {
            logger.debug({ owner, key }, "genesis-tools config: a stored key no schema names, ignored");
            continue;
        }

        const parsed = schema.safeParse(value);

        if (!parsed.success) {
            logger.warn(
                { owner, key, issues: parsed.error.issues.map((issue) => issue.message) },
                "genesis-tools config: a stored value does not match its schema, the default applies"
            );
            continue;
        }

        checked[key] = parsed.data;
    }

    return checked;
}

/** The pure resolution: defaults (area, then action), then stored area values, then stored action values. */
export function resolveConfig(
    file: GenesisToolsConfigFile,
    areaDef: AnyArea,
    action?: string
): Record<string, unknown> {
    const { actions: storedActions, ...storedArea } = file.areas[areaDef.area] ?? {};
    const actionDef = action ? areaDef.actions[action] : undefined;
    const storedAction = action && isObject(storedActions) ? storedActions[action] : undefined;
    const areaSchema = (key: string): z.ZodType | undefined => areaDef.config?.shape[key];

    return {
        ...schemaDefaults(areaDef.config),
        ...schemaDefaults(actionDef?.config),
        ...checkedValues(storedArea, areaSchema, areaDef.area),
        ...(isObject(storedAction)
            ? checkedValues(
                  storedAction,
                  (key) => actionDef?.config?.shape[key] ?? areaSchema(key),
                  `${areaDef.area}.${action}`
              )
            : {}),
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
    // A set writes a whole new file beside the old one and renames it over, so a reader never sees half a file and a
    // failed write keeps the old choices. A file that does not parse is the person's data: a set refuses it.
    const document = jsonDocument<GenesisToolsConfigFile>({
        path: file,
        empty: emptyConfigFile,
        decode: decodeConfigFile,
        encode: (doc) => `${SafeJSON.stringify(doc, null, 4)}\n`,
        onUnreadable: "refuse",
        unreadableError: (problem) =>
            new ConfigError(
                problem.cause instanceof Error ? `${problem.message}: ${problem.cause.message}` : problem.message
            ),
    });

    function read(): GenesisToolsConfigFile {
        return document.read();
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

        await document.update((current) => ({ write: withKey(current, target, stored), result: undefined }));

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
