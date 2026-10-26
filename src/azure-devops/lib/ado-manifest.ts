import { SafeJSON } from "@genesiscz/utils/json";

/**
 * A generated manifest of one piece of an Azure DevOps project's configuration (fields, workflow, sprints, …).
 * Every kind shares this envelope: a `meta` block and one payload key. Code imports the generated file instead
 * of hard-coding ids, and `maintenance check` reports where ADO moved since the file was written.
 */
export interface AdoManifestMeta {
    /** Which manifest this is. Files written before kinds existed have none and are field manifests. */
    kind?: string;
    org: string;
    project: string;
    process: string | null;
    /** Local time, minute resolution. */
    fetchedAt: string;
    regenerate: string;
}

export interface AdoManifest {
    meta: AdoManifestMeta;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const TS_EXPORT = /export const [A-Za-z_$][\w$]* = /;
const TS_SUFFIX = " as const;";

export function isIdentifier(name: string): boolean {
    return IDENTIFIER.test(name);
}

export function renderManifestJson(manifest: AdoManifest): string {
    return `${SafeJSON.stringify(manifest, null, 4)}\n`;
}

export function renderManifestTs(manifest: AdoManifest, exportName: string): string {
    if (!isIdentifier(exportName)) {
        throw new Error(`"${exportName}" is not a TypeScript identifier`);
    }

    return [
        "// Generated, do not edit. Regenerate with:",
        `//   ${manifest.meta.regenerate}`,
        `export const ${exportName} = ${SafeJSON.stringify(manifest, null, 4)}${TS_SUFFIX}`,
        "",
    ].join("\n");
}

/** Reads a manifest written by `renderManifestJson` or `renderManifestTs`, whatever its export name. */
export function parseManifestText(text: string, path: string): AdoManifest & Record<string, unknown> {
    let json = text;

    if (path.endsWith(".ts")) {
        const start = TS_EXPORT.exec(text);
        const end = text.lastIndexOf(TS_SUFFIX);

        if (!start || end <= start.index) {
            throw new Error(`${path} has no "export const <Name> = … ${TS_SUFFIX}" block`);
        }

        json = text.slice(start.index + start[0].length, end);
    }

    const parsed: unknown = SafeJSON.parse(json, { strict: true });

    if (!isRecord(parsed) || !isRecord(parsed.meta) || typeof parsed.meta.regenerate !== "string") {
        throw new Error(`${path} is not an ADO manifest (no meta block)`);
    }

    return { ...parsed, meta: readMeta(parsed.meta) };
}

function readMeta(meta: Record<string, unknown>): AdoManifestMeta {
    const text = (key: string): string => (typeof meta[key] === "string" ? String(meta[key]) : "");

    return {
        ...(typeof meta.kind === "string" ? { kind: meta.kind } : {}),
        org: text("org"),
        project: text("project"),
        process: typeof meta.process === "string" ? meta.process : null,
        fetchedAt: text("fetchedAt"),
        regenerate: text("regenerate"),
    };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sortedRecord<T>(entries: [string, T][]): Record<string, T> {
    const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(sorted);
}

function show(value: unknown): string {
    return typeof value === "string" ? `"${value}"` : SafeJSON.stringify(value);
}

/**
 * The differences between two manifests, one line each, `meta` left out. Objects are compared key by key; a list
 * of plain values reports the items added and removed (or a reorder); any other list is compared whole.
 */
export function diffManifestData(saved: object, live: object): string[] {
    const drift: string[] = [];

    const walk = (before: unknown, after: unknown, path: string): void => {
        if (isRecord(before) && isRecord(after)) {
            const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

            for (const key of keys) {
                if (!path && key === "meta") {
                    continue;
                }

                const at = path ? `${path} > ${key}` : key;

                if (!(key in before)) {
                    drift.push(`${at}: added ${show(after[key])}`);
                } else if (!(key in after)) {
                    drift.push(`${at}: removed`);
                } else {
                    walk(before[key], after[key], at);
                }
            }

            return;
        }

        if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every(isPlain)) {
            const added = after.filter((item) => !before.includes(item));
            const removed = before.filter((item) => !after.includes(item));

            if (added.length > 0 || removed.length > 0) {
                const parts = [
                    added.length > 0 ? `added ${added.map(show).join(", ")}` : "",
                    removed.length > 0 ? `removed ${removed.map(show).join(", ")}` : "",
                ];
                drift.push(`${path}: ${parts.filter(Boolean).join("; ")}`);
            } else if (before.some((item, index) => item !== after[index])) {
                drift.push(`${path}: order ${show(before)} -> ${show(after)}`);
            }

            return;
        }

        if (SafeJSON.stringify(before) !== SafeJSON.stringify(after)) {
            drift.push(`${path}: ${show(before)} -> ${show(after)}`);
        }
    };

    walk(saved, live, "");
    return drift;
}

function isPlain(value: unknown): value is string | number | boolean | null {
    return value === null || ["string", "number", "boolean"].includes(typeof value);
}
