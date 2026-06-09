import type { StudyMeta } from "./types";

export type StudyInputValue = { v: unknown; f: true; t: string };
export type StudyValues = { text: string; pineId: string; pineVersion: string } & Record<
    string,
    StudyInputValue | string
>;

/** ["Length=21", ...] -> { length: "21" } (keys lowercased for case-insensitive matching). */
export function parseInputFlags(flags: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const flag of flags) {
        const eq = flag.indexOf("=");
        if (eq <= 0) {
            throw new Error(`--input "${flag}": expected name=value`);
        }

        result[flag.slice(0, eq).trim().toLowerCase()] = flag.slice(eq + 1).trim();
    }

    return result;
}

export function coerceInputValue(raw: string, type: string): unknown {
    if (type === "integer") {
        const n = Number(raw);
        if (!Number.isInteger(n)) {
            throw new Error(`"${raw}" is not a valid integer`);
        }

        return n;
    }

    if (type === "float") {
        const n = Number(raw);
        if (Number.isNaN(n)) {
            throw new Error(`"${raw}" is not a valid number`);
        }

        return n;
    }

    if (type === "bool") {
        return raw === "true" || raw === "1";
    }

    return raw;
}

/** Merge meta defaults with user overrides into the create_study values object. */
export function buildStudyValues(meta: StudyMeta, overrides: Record<string, string>): StudyValues {
    const values: StudyValues = { text: meta.ilTemplate, pineId: meta.pineId, pineVersion: meta.pineVersion };
    const known = new Map<string, (typeof meta.inputs)[number]>();
    for (const input of meta.inputs) {
        known.set(input.name.toLowerCase(), input);
        known.set(input.id.toLowerCase(), input);
        values[input.id] = { v: input.defval, f: true, t: input.type };
    }

    for (const [key, raw] of Object.entries(overrides)) {
        const input = known.get(key);
        if (!input) {
            const names = meta.inputs.map((i) => i.name).join(", ");
            throw new Error(`Unknown input "${key}". Available inputs: ${names}`);
        }

        values[input.id] = { v: coerceInputValue(raw, input.type), f: true, t: input.type };
    }

    return values;
}
