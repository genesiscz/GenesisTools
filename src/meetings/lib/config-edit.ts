import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { type MeetingsConfig, type MeetingsConfigStore, meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import { closestName } from "@genesiscz/utils/transclude/registry";
import { z } from "zod";

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

/** The settings schema as JSON Schema, made once: which keys each level knows, where a record takes any key. */
let configShape: unknown;

function shapeOfConfig(): unknown {
    configShape ??= z.toJSONSchema(meetingsConfigSchema, { io: "input", unrepresentable: "any" });
    return configShape;
}

/** The schema node one segment below `node`: a known key, any key of a record, an array index, or a union branch. */
function childNode(node: unknown, segment: string): unknown {
    if (!isObject(node)) {
        return undefined;
    }

    if (isObject(node.properties) && Object.hasOwn(node.properties, segment)) {
        return node.properties[segment];
    }

    if (isObject(node.additionalProperties)) {
        return node.additionalProperties;
    }

    if (/^\d+$/.test(segment) && isObject(node.items)) {
        return node.items;
    }

    for (const key of ["anyOf", "oneOf", "allOf"]) {
        const branches = node[key];

        for (const branch of Array.isArray(branches) ? branches : []) {
            const found = childNode(branch, segment);

            if (found !== undefined) {
                return found;
            }
        }
    }

    return undefined;
}

/** A node that names no keys of its own takes any below it (an unrepresentable part, a free object). */
function takesAnyKey(node: unknown): boolean {
    return (
        isObject(node) &&
        node.properties === undefined &&
        node.additionalProperties === undefined &&
        node.items === undefined &&
        node.anyOf === undefined &&
        node.oneOf === undefined &&
        node.allOf === undefined &&
        (node.type === undefined || node.type === "object")
    );
}

/**
 * Why a path names no setting, or undefined when it does: a misspelled key must be refused, because the schema drops
 * an unknown key, so the write said ✓ and changed nothing (MC6, 2026-11-06: `global.capture.activFps`).
 */
export function unknownConfigPath(segments: string[]): { reason: string; settings: string } | undefined {
    let node = shapeOfConfig();

    for (const [index, segment] of segments.entries()) {
        if (takesAnyKey(node)) {
            return undefined;
        }

        const next = childNode(node, segment);

        if (next === undefined) {
            const parent = segments.slice(0, index).join(".");
            const known = isObject(node) && isObject(node.properties) ? Object.keys(node.properties) : [];
            const hint = closestName(segment, known);
            return {
                reason: `${parent || "the config"} has no setting "${segment}"${hint ? `; did you mean "${hint}"?` : "."}`,
                settings: toolCommand("meetings", "config", "show", ...(parent ? [parent] : [])),
            };
        }

        node = next;
    }

    return undefined;
}

/**
 * For `config show`: a key of a map (`projects.<name>`, `sources.<id>`) that the config does not hold. The schema
 * takes any name there, so the path is valid, but its `null` read like an unset value of a project that exists (R2-MC6).
 */
export function missingMapKey(
    config: MeetingsConfig,
    segments: string[]
): { reason: string; settings: string } | undefined {
    let node = shapeOfConfig();
    let current: unknown = config;

    for (const [index, segment] of segments.entries()) {
        const named = isObject(node) && isObject(node.properties) && Object.hasOwn(node.properties, segment);
        const map = isObject(node) && isObject(node.additionalProperties);

        if (!named && map && isObject(current) && !Object.hasOwn(current, segment)) {
            const parent = segments.slice(0, index).join(".");
            const held = Object.keys(current);
            return {
                reason: `${parent} has no "${segment}"; it holds ${held.length > 0 ? held.join(", ") : "nothing"}.`,
                settings: toolCommand("meetings", "config", "show", parent),
            };
        }

        const next = childNode(node, segment);

        if (next === undefined) {
            return undefined;
        }

        node = next;
        current = isObject(current) ? current[segment] : undefined;
    }

    return undefined;
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

/** One change of a config edit: a value to write, or `unset` to remove the key so its default applies again. */
export type ConfigEdit = { path: string; expect?: unknown } & ({ value: unknown; unset?: never } | { unset: true });

const configEditSchema = z.union([
    z.object({ path: z.string().min(1), value: z.unknown(), expect: z.unknown().optional() }).strict(),
    z.object({ path: z.string().min(1), unset: z.literal(true), expect: z.unknown().optional() }).strict(),
]);

const EDITS_SHAPE =
    "config edit takes a JSON array of { path, value, expect? } or { path, unset: true, expect? } (expect: the value the change replaces)";

/** `config edit`'s argument as edits, or the shape it takes; text that is not JSON gets the shape too, with the reason (R2-MC6). */
export function parseConfigEdits(text: string): { edits: ConfigEdit[] } | { error: string } {
    let json: unknown;

    try {
        json = SafeJSON.parse(text, { strict: true });
    } catch (err) {
        return { error: `${EDITS_SHAPE}; this text is not JSON: ${err instanceof Error ? err.message : String(err)}` };
    }

    const parsed = z.array(configEditSchema).min(1).safeParse(json);

    if (!parsed.success) {
        return { error: EDITS_SHAPE };
    }

    return {
        edits: parsed.data.map((one) =>
            "unset" in one
                ? { path: one.path, unset: true, ...("expect" in one ? { expect: one.expect } : {}) }
                : { path: one.path, value: one.value, ...("expect" in one ? { expect: one.expect } : {}) }
        ),
    };
}

function same(left: unknown, right: unknown): boolean {
    return Bun.deepEquals(left ?? null, right ?? null, true);
}

/**
 * Applies several changes in one write under the config's lock. An edit with `expect` names the value (with its
 * default filled in) the caller saw at its path; when the file holds another one now, another editor changed it, and
 * nothing is written (`config-stale`). The whole config must still validate, or nothing is written and the schema's
 * sentence is thrown.
 */
export async function applyConfigEdits(store: MeetingsConfigStore, edits: ConfigEdit[]): Promise<MeetingsConfig> {
    const parsed = edits.map((edit) => ({ edit, segments: parseConfigPath(edit.path) }));

    // An unset may name an unknown key: that is how a key an older version wrote is removed again.
    for (const { edit, segments } of parsed) {
        const unknown = "unset" in edit && edit.unset ? undefined : unknownConfigPath(segments);

        if (unknown) {
            throw new Error(`${unknown.reason} Nothing was written. Its settings: ${unknown.settings}`);
        }
    }

    return store.update((raw) => {
        const guarded = parsed.filter(({ edit }) => "expect" in edit);

        if (guarded.length > 0) {
            const current = meetingsConfigSchema.parse(structuredClone(raw));

            for (const { edit, segments } of guarded) {
                const now = configValueAt(current, segments);

                if (!same(now, edit.expect)) {
                    throw new MeetingsConflictError(
                        "config-stale",
                        `${segments.join(".")} changed since it was read: it is ${SafeJSON.stringify(now ?? null)} now, not ${SafeJSON.stringify(edit.expect ?? null)}; nothing was written. Read it again and repeat the change`
                    );
                }
            }
        }

        for (const { edit, segments } of parsed) {
            if ("unset" in edit && edit.unset) {
                unsetAt(raw, segments);
            } else {
                setAt(raw, segments, edit.value);
            }
        }
    });
}

function setAt(raw: Record<string, unknown>, segments: string[], value: unknown): void {
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

    parent[segments.at(-1) ?? ""] = value;
}

function unsetAt(raw: Record<string, unknown>, segments: string[]): void {
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
}

/**
 * Writes one value into the config file under its lock. The missing objects on the way are created; the whole config
 * must still validate, or nothing is written and the schema's sentence is thrown. `expect`: see `applyConfigEdits`.
 */
export async function setConfigValue(
    store: MeetingsConfigStore,
    path: string,
    value: unknown,
    options: { expect?: unknown } = {}
): Promise<MeetingsConfig> {
    return applyConfigEdits(store, [{ path, value, ...("expect" in options ? { expect: options.expect } : {}) }]);
}

/** Removes one key from the config file, so its default applies again. A missing key changes nothing. */
export async function unsetConfigValue(
    store: MeetingsConfigStore,
    path: string,
    options: { expect?: unknown } = {}
): Promise<MeetingsConfig> {
    return applyConfigEdits(store, [{ path, unset: true, ...("expect" in options ? { expect: options.expect } : {}) }]);
}
