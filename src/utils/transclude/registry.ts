import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { levenshteinDistance } from "@genesiscz/utils/fuzzy-match";
import type {
    LineRange,
    TransclusionDefinition,
    TransclusionParam,
    TransclusionParams,
    TransclusionParamValue,
} from "./types";

/** An expected failure: its message is the reason printed to the user, without a stack. */
export class TransclusionError extends Error {}

/** Returns the definition unchanged; exists so a new kind is typed at its declaration. */
export function defineTransclusion(definition: TransclusionDefinition): TransclusionDefinition {
    return definition;
}

export interface TransclusionRegistry {
    get(name: string): TransclusionDefinition | undefined;
    list(): TransclusionDefinition[];
    /** Adds a kind; a name already taken throws, so two kinds cannot silently shadow each other. */
    define(definition: TransclusionDefinition): void;
}

export function createTransclusionRegistry(definitions: TransclusionDefinition[] = []): TransclusionRegistry {
    const byName = new Map<string, TransclusionDefinition>();

    const registry: TransclusionRegistry = {
        get: (name) => byName.get(name) ?? byName.get(name.toLowerCase()),
        list: () => [...byName.values()],
        define(definition) {
            if (byName.has(definition.name)) {
                throw new Error(`transclusion kind "${definition.name}" is already defined`);
            }

            checkDefinition(definition);
            byName.set(definition.name, definition);
        },
    };

    for (const definition of definitions) {
        registry.define(definition);
    }

    return registry;
}

/** Catches a malformed definition when it is registered, not when the first token hits it. */
function checkDefinition(definition: TransclusionDefinition): void {
    const names = new Set<string>();

    for (const param of definition.params) {
        if (names.has(param.name)) {
            throw new Error(`transclusion kind "${definition.name}" declares param "${param.name}" twice`);
        }

        if (param.type === "enum" && !param.values?.length) {
            throw new Error(`transclusion kind "${definition.name}": enum param "${param.name}" needs values`);
        }

        names.add(param.name);
    }

    for (const group of definition.requireOneOf ?? []) {
        const unknown = group.find((name) => !names.has(name));

        if (unknown) {
            throw new Error(`transclusion kind "${definition.name}": requireOneOf names unknown param "${unknown}"`);
        }
    }
}

/** The closest name within an edit distance of 2, for a "did you mean" hint. */
export function closestName(name: string, candidates: string[]): string | undefined {
    let best: { name: string; distance: number } | undefined;

    for (const candidate of candidates) {
        const distance = levenshteinDistance(name, candidate);

        if (distance <= 2 && (!best || distance < best.distance)) {
            best = { name: candidate, distance };
        }
    }

    return best?.name;
}

export function unknownKindMessage(kind: string, registry: TransclusionRegistry): string {
    const names = registry.list().map((definition) => definition.name);
    const hint = closestName(kind, names);
    return hint
        ? `unknown kind "${kind}" (did you mean ${hint}?)`
        : `unknown kind "${kind}" (known: ${names.join(", ")})`;
}

/**
 * Checks raw token params against the definition and converts them to typed values. Throws a
 * TransclusionError naming the first problem: an unknown or missing param, a bad value, or a
 * `requireOneOf` group with none or several of its params.
 */
export function validateTransclusionParams({
    definition,
    raw,
    cwd,
}: {
    definition: TransclusionDefinition;
    raw: Record<string, string>;
    cwd: string;
}): TransclusionParams {
    const declared = new Map(definition.params.map((param) => [param.name, param]));
    const expected = definition.params.map((param) => param.name).join(", ");

    for (const name of Object.keys(raw)) {
        if (!declared.has(name)) {
            const hint = closestName(name, [...declared.keys()]);
            throw new TransclusionError(
                `unknown param "${name}" for ${definition.name} (expected: ${expected}${hint ? `; did you mean ${hint}?` : ""})`
            );
        }
    }

    const values: Record<string, TransclusionParamValue> = {};

    for (const param of definition.params) {
        const given = raw[param.name];

        if (given === undefined) {
            if (param.required) {
                throw new TransclusionError(
                    `missing required param "${param.name}" for ${definition.name} (expected: ${expected})`
                );
            }

            if (param.default !== undefined) {
                values[param.name] = param.default;
            }

            continue;
        }

        values[param.name] = convert({ param, value: given, kind: definition.name, cwd });
    }

    for (const group of definition.requireOneOf ?? []) {
        const present = group.filter((name) => raw[name] !== undefined);

        if (present.length !== 1) {
            const verb = present.length === 0 ? "needs one of" : "takes only one of";
            throw new TransclusionError(`${definition.name} ${verb} ${group.join(", ")}`);
        }
    }

    return paramsAccessor(definition, values);
}

function convert({
    param,
    value,
    kind,
    cwd,
}: {
    param: TransclusionParam;
    value: string;
    kind: string;
    cwd: string;
}): TransclusionParamValue {
    const bad = (expects: string): TransclusionError =>
        new TransclusionError(`param "${param.name}" of ${kind} expects ${expects}, got "${value}"`);

    switch (param.type) {
        case "string":
            return value;
        case "path":
            return resolvePath(value, cwd);
        case "int": {
            const number = Number(value.trim());

            if (!value.trim() || !Number.isInteger(number)) {
                throw bad("an integer");
            }

            return number;
        }
        case "bool": {
            const normalized = value.trim().toLowerCase();

            if (["true", "yes", "1", "on"].includes(normalized)) {
                return true;
            }

            if (["false", "no", "0", "off"].includes(normalized)) {
                return false;
            }

            throw bad("true or false");
        }
        case "enum": {
            if (!param.values?.includes(value)) {
                throw bad(`one of ${param.values?.join(", ")}`);
            }

            return value;
        }
        case "url": {
            const url = URL.canParse(value) ? new URL(value) : null;

            if (url && (url.protocol === "http:" || url.protocol === "https:")) {
                return url.href;
            }

            throw bad("an http(s) URL");
        }
        case "range": {
            const range = parseLineRange(value);

            if (!range) {
                throw bad("a line range like 10-40, 10, 10- or -40");
            }

            return range;
        }
    }
}

/** `10-40`, `10`, `10-`, `-40`, and the GitHub form `L10-L40`. Null for anything else. */
export function parseLineRange(value: string): LineRange | null {
    const match = /^\s*L?(\d*)\s*(?:(-)\s*L?(\d*))?\s*$/i.exec(value);

    if (!match || (!match[1] && !match[3])) {
        return null;
    }

    const start = match[1] ? Number(match[1]) : 1;
    const end = match[2] ? (match[3] ? Number(match[3]) : null) : start;

    if (start < 1 || (end !== null && end < start)) {
        return null;
    }

    return { start, end };
}

export function formatLineRange(range: LineRange): string {
    if (range.end === range.start) {
        return String(range.start);
    }

    return `${range.start}-${range.end ?? ""}`;
}

/** `~` expands to the home folder; a relative path resolves against the caller's cwd. */
export function resolvePath(value: string, cwd: string): string {
    const trimmed = value.trim();

    if (trimmed === "~" || trimmed.startsWith("~/")) {
        return resolve(homedir(), trimmed.slice(2));
    }

    return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

function paramsAccessor(
    definition: TransclusionDefinition,
    values: Record<string, TransclusionParamValue>
): TransclusionParams {
    const declared = new Set(definition.params.map((param) => param.name));

    const read = (name: string): TransclusionParamValue | undefined => {
        if (!declared.has(name)) {
            throw new Error(`transclusion kind "${definition.name}" reads undeclared param "${name}"`);
        }

        return values[name];
    };

    const required = <T>(name: string, value: T | undefined): T => {
        if (value === undefined) {
            throw new TransclusionError(`missing param "${name}" for ${definition.name}`);
        }

        return value;
    };

    const asString = (name: string): string | undefined => {
        const value = read(name);
        return typeof value === "string" ? value : value === undefined ? undefined : String(value);
    };

    const asInt = (name: string): number | undefined => {
        const value = read(name);
        return typeof value === "number" ? value : undefined;
    };

    const asRange = (name: string): LineRange | undefined => {
        const value = read(name);
        return typeof value === "object" ? value : undefined;
    };

    return {
        has: (name) => read(name) !== undefined,
        string: (name) => required(name, asString(name)),
        optionalString: asString,
        int: (name) => required(name, asInt(name)),
        optionalInt: asInt,
        bool: (name) => read(name) === true,
        range: (name) => required(name, asRange(name)),
        optionalRange: asRange,
        values: () => ({ ...values }),
    };
}
