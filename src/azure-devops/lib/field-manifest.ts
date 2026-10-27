import {
    type AdoManifestMeta,
    isRecord,
    parseManifestText,
    renderManifestTs as renderTs,
    sortedRecord,
} from "@app/azure-devops/lib/ado-manifest";

export { isIdentifier, renderManifestJson } from "@app/azure-devops/lib/ado-manifest";
export type { AdoManifestMeta };

/**
 * A field manifest of one Azure DevOps project: per work item type, every field with its label, data type and
 * allowed values, and the type's states. Conventions look a field up by label or value through `findField`,
 * instead of hard-coding a generated reference name such as `Custom.<guid>`.
 */
export interface AdoFieldManifest {
    meta: AdoManifestMeta;
    types: Record<string, AdoTypeEntry>;
}

export interface AdoTypeEntry {
    states: AdoStateEntry[];
    fields: Record<string, AdoFieldEntry>;
}

export interface AdoStateEntry {
    name: string;
    category: string;
}

export interface AdoFieldEntry {
    name: string;
    type: string;
    isIdentity: boolean;
    alwaysRequired: boolean;
    allowedValues: string[];
}

/** One field of the project-wide catalog (`_apis/wit/fields`), which carries the data type. */
export interface CatalogField {
    referenceName: string;
    type?: string;
    isIdentity?: boolean;
}

/** One field as `_apis/wit/workitemtypes/<type>/fields?$expand=allowedValues` returns it. */
export interface TypeFieldInput {
    referenceName: string;
    name: string;
    alwaysRequired?: boolean;
    allowedValues?: string[];
}

export interface TypeInput {
    name: string;
    fields: TypeFieldInput[];
    states: { name: string; category?: string }[];
}

export const DEFAULT_MANIFEST_EXPORT = "AdoFields";

/** Types and fields are sorted by name, so a regenerated file differs only where ADO changed. */
export function buildFieldManifest(input: {
    meta: AdoManifestMeta;
    catalog: CatalogField[];
    types: TypeInput[];
}): AdoFieldManifest {
    const catalog = new Map(input.catalog.map((field) => [field.referenceName, field]));

    const types = input.types.map((type): [string, AdoTypeEntry] => {
        const fields = type.fields.map((field): [string, AdoFieldEntry] => {
            const known = catalog.get(field.referenceName);
            return [
                field.referenceName,
                {
                    name: field.name,
                    type: known?.type ?? "unknown",
                    isIdentity: known?.isIdentity ?? false,
                    alwaysRequired: field.alwaysRequired ?? false,
                    allowedValues: field.allowedValues ?? [],
                },
            ];
        });

        return [
            type.name,
            {
                states: type.states.map((state) => ({ name: state.name, category: state.category ?? "" })),
                fields: sortedRecord(fields),
            },
        ];
    });

    return { meta: { kind: "fields", ...input.meta }, types: sortedRecord(types) };
}

export function renderManifestTs(manifest: AdoFieldManifest, exportName = DEFAULT_MANIFEST_EXPORT): string {
    return renderTs(manifest, exportName);
}

export function renderManifestMd(manifest: AdoFieldManifest): string {
    const { meta } = manifest;
    const lines = [
        `# Work item fields: ${meta.project}`,
        "",
        `Organization ${meta.org}, process ${meta.process ?? "unknown"}, fetched ${meta.fetchedAt}.`,
        `Regenerate with \`${meta.regenerate}\`.`,
    ];

    for (const [typeName, type] of Object.entries(manifest.types)) {
        lines.push("", `## ${typeName}`, "");
        lines.push(`States: ${type.states.map((state) => `${state.name} (${state.category})`).join(", ")}`, "");

        for (const [referenceName, field] of Object.entries(type.fields)) {
            const traits = [field.type, field.isIdentity ? "identity" : "", field.alwaysRequired ? "required" : ""]
                .filter(Boolean)
                .join(", ");
            const values = field.allowedValues.length > 0 ? `: ${field.allowedValues.join(" | ")}` : "";
            lines.push(`- \`${referenceName}\` "${field.name}" (${traits})${values}`);
        }
    }

    return `${lines.join("\n")}\n`;
}

/** Reads a field manifest written as .ts (any export name) or .json. */
export function parseManifestFile(text: string, path: string): AdoFieldManifest {
    const parsed = parseManifestText(text, path);

    const types = parsed.types;

    if (!isFieldTypes(types)) {
        throw new Error(`${path} is not a field manifest (no types with fields and states)`);
    }

    return { meta: parsed.meta, types };
}

function isFieldTypes(value: unknown): value is Record<string, AdoTypeEntry> {
    return (
        isRecord(value) &&
        Object.values(value).every((type) => isRecord(type) && isRecord(type.fields) && Array.isArray(type.states))
    );
}

function sameList(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

function quoteList(values: string[]): string {
    return `[${values.join(", ")}]`;
}

/** What changed in ADO since `saved` was written. The meta block (fetch time, command) is not compared. */
export function diffManifests(saved: AdoFieldManifest, live: AdoFieldManifest): string[] {
    const drift: string[] = [];
    const typeNames = [...new Set([...Object.keys(saved.types), ...Object.keys(live.types)])].sort();

    for (const typeName of typeNames) {
        const before = saved.types[typeName];
        const after = live.types[typeName];

        if (!before || !after) {
            drift.push(`${typeName}: type ${before ? "removed" : "added"}`);
            continue;
        }

        const statesBefore = before.states.map((state) => `${state.name}/${state.category}`);
        const statesAfter = after.states.map((state) => `${state.name}/${state.category}`);

        if (!sameList(statesBefore, statesAfter)) {
            drift.push(`${typeName}: states ${quoteList(statesBefore)} -> ${quoteList(statesAfter)}`);
        }

        const refs = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])].sort();

        for (const ref of refs) {
            const old = before.fields[ref];
            const now = after.fields[ref];

            if (!old || !now) {
                drift.push(`${typeName}: field ${ref} "${(old ?? now)?.name}" ${old ? "removed" : "added"}`);
                continue;
            }

            if (old.name !== now.name) {
                drift.push(`${typeName}: field ${ref} label "${old.name}" -> "${now.name}"`);
            }

            if (old.type !== now.type) {
                drift.push(`${typeName}: field ${ref} type ${old.type} -> ${now.type}`);
            }

            if (old.isIdentity !== now.isIdentity) {
                drift.push(`${typeName}: field ${ref} identity ${old.isIdentity} -> ${now.isIdentity}`);
            }

            if (old.alwaysRequired !== now.alwaysRequired) {
                drift.push(`${typeName}: field ${ref} required ${old.alwaysRequired} -> ${now.alwaysRequired}`);
            }

            if (!sameList(old.allowedValues, now.allowedValues)) {
                drift.push(
                    `${typeName}: field ${ref} values ${quoteList(old.allowedValues)} -> ${quoteList(now.allowedValues)}`
                );
            }
        }
    }

    return drift;
}

export interface FieldQuery {
    /** Work item type name; any type when omitted. */
    type?: string;
    /** A string matches the label exactly, ignoring case; a RegExp is tested against it. */
    label?: string | RegExp;
    /** The field must allow this value (ignoring case). */
    value?: string;
}

export interface FieldMatch {
    referenceName: string;
    name: string;
    type: string;
    isIdentity: boolean;
    allowedValues: string[];
    /** Work item types that have this field and match the query. */
    types: string[];
}

function matchesLabel(label: string, query: FieldQuery["label"]): boolean {
    if (query === undefined) {
        return true;
    }

    return typeof query === "string"
        ? label.toLowerCase() === query.toLowerCase()
        : new RegExp(query.source, query.flags).test(label);
}

type FieldLookupManifest = Omit<AdoFieldManifest, "types"> & {
    types: Readonly<
        Record<
            string,
            {
                states: readonly AdoStateEntry[];
                fields: Readonly<
                    Record<string, Omit<AdoFieldEntry, "allowedValues"> & { allowedValues: readonly string[] }>
                >;
            }
        >
    >;
};

/** Every field that matches, one entry per reference name. */
export function findFields(manifest: FieldLookupManifest, query: FieldQuery): FieldMatch[] {
    const matches = new Map<string, FieldMatch>();
    const value = query.value?.toLowerCase();

    for (const [typeName, type] of Object.entries(manifest.types)) {
        if (query.type && typeName.toLowerCase() !== query.type.toLowerCase()) {
            continue;
        }

        for (const [referenceName, field] of Object.entries(type.fields)) {
            if (!matchesLabel(field.name, query.label)) {
                continue;
            }

            if (value && !field.allowedValues.some((allowed) => allowed.toLowerCase() === value)) {
                continue;
            }

            const known = matches.get(referenceName);

            if (known) {
                known.types.push(typeName);
                continue;
            }

            matches.set(referenceName, {
                referenceName,
                name: field.name,
                type: field.type,
                isIdentity: field.isIdentity,
                allowedValues: [...field.allowedValues],
                types: [typeName],
            });
        }
    }

    return [...matches.values()];
}

/** The one field that matches, or undefined. Throws when the query matches more than one reference name. */
export function findField(manifest: FieldLookupManifest, query: FieldQuery): FieldMatch | undefined {
    const matches = findFields(manifest, query);

    if (matches.length > 1) {
        const names = matches.map((match) => `${match.referenceName} "${match.name}"`).join(", ");
        throw new Error(`The field query matches ${matches.length} fields: ${names}`);
    }

    return matches[0];
}
