import { SafeJSON } from "@genesiscz/utils/json";
import type { MeetingsConfig, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";

/** Keys a path may never walk through: they reach the object's prototype, not the config. */
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/**
 * A config path as its segments. A JSON array (`["projects","a.b","labels"]`) keeps a project name with a dot whole;
 * a dotted path (`global.capture.activeFps`) is the short form for a person typing it.
 */
export function parseConfigPath(path: string): string[] {
    const text = path.trim();
    const segments = text.startsWith("[") ? jsonSegments(text) : text.split(".");

    if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
        throw new Error(`"${path}" is not a config path (try global.capture.activeFps)`);
    }

    const bad = segments.find((segment) => FORBIDDEN.has(segment));

    if (bad) {
        throw new Error(`a config path cannot name "${bad}"`);
    }

    return segments;
}

function jsonSegments(text: string): string[] {
    const parsed: unknown = SafeJSON.parse(text, { strict: true });

    if (!Array.isArray(parsed) || !parsed.every((segment) => typeof segment === "string")) {
        throw new Error(`${text} is not a JSON array of keys`);
    }

    return parsed;
}

/** A value from the command line: JSON when it parses (`2`, `true`, `["cs-CZ"]`, `"x"`), else the plain text. */
export function parseConfigValue(text: string): unknown {
    try {
        return SafeJSON.parse(text, { strict: true });
    } catch {
        return text;
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The value at a path of the config with its defaults filled in, or undefined. */
export function configValueAt(config: MeetingsConfig, segments: string[]): unknown {
    let current: unknown = config;

    for (const segment of segments) {
        if (!isObject(current)) {
            return undefined;
        }

        current = current[segment];
    }

    return current;
}

/**
 * Writes one value into the config file under its lock. The missing objects on the way are created; the whole config
 * must still validate, or nothing is written and the schema's sentence is thrown.
 */
export async function setConfigValue(
    store: MeetingsConfigStore,
    path: string,
    value: unknown
): Promise<MeetingsConfig> {
    const segments = parseConfigPath(path);
    const key = segments.at(-1) ?? "";

    return store.update((raw) => {
        let parent: Record<string, unknown> = raw;

        for (const segment of segments.slice(0, -1)) {
            const next = parent[segment];

            if (next === undefined) {
                const created: Record<string, unknown> = {};
                parent[segment] = created;
                parent = created;
                continue;
            }

            if (!isObject(next)) {
                throw new Error(`${segments.join(".")}: ${segment} is not an object`);
            }

            parent = next;
        }

        parent[key] = value;
    });
}

/** Removes one key from the config file, so its default applies again. A missing key changes nothing. */
export async function unsetConfigValue(store: MeetingsConfigStore, path: string): Promise<MeetingsConfig> {
    const segments = parseConfigPath(path);

    return store.update((raw) => {
        let parent: unknown = raw;

        for (const segment of segments.slice(0, -1)) {
            if (!isObject(parent)) {
                return;
            }

            parent = parent[segment];
        }

        if (isObject(parent)) {
            delete parent[segments.at(-1) ?? ""];
        }
    });
}
