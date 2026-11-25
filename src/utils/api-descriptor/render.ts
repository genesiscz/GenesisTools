import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { type ApiDescriptor, effectLabel, type HandleDescriptor, type MethodDescriptor } from "./descriptor";

const { log } = logger.scoped("api-descriptor");

export type JsonSchema = {
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema | JsonSchema[];
    prefixItems?: JsonSchema[];
    enum?: unknown[];
    const?: unknown;
    anyOf?: JsonSchema[];
    oneOf?: JsonSchema[];
    allOf?: JsonSchema[];
    additionalProperties?: boolean | JsonSchema;
    default?: unknown;
    title?: string;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
};

/**
 * A number's bounds as the reader needs them: `(0–0.3)`, `(≥0.5)`, `(>0)`. Without them an agent learned a limit only
 * from the error of its first wrong call (blind test 2026-11-04).
 */
function rangeText(raw: JsonSchema): string {
    // zod's .int() bounds every integer by the safe range, which says nothing to a reader.
    const real = (value: number | undefined) =>
        value !== undefined && Math.abs(value) < Number.MAX_SAFE_INTEGER ? value : undefined;
    const schema = {
        minimum: real(raw.minimum),
        maximum: real(raw.maximum),
        exclusiveMinimum: real(raw.exclusiveMinimum),
        exclusiveMaximum: real(raw.exclusiveMaximum),
    };
    const low = schema.minimum ?? schema.exclusiveMinimum;
    const high = schema.maximum ?? schema.exclusiveMaximum;

    if (
        low !== undefined &&
        high !== undefined &&
        schema.exclusiveMinimum === undefined &&
        schema.exclusiveMaximum === undefined
    ) {
        return ` (${low}–${high})`;
    }

    const parts = [
        schema.minimum !== undefined ? `≥${schema.minimum}` : undefined,
        schema.exclusiveMinimum !== undefined ? `>${schema.exclusiveMinimum}` : undefined,
        schema.maximum !== undefined ? `≤${schema.maximum}` : undefined,
        schema.exclusiveMaximum !== undefined ? `<${schema.exclusiveMaximum}` : undefined,
    ].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** The JSON Schema of one side of a schema; `{}` (any) where zod cannot express it (a function, a custom type). */
export function jsonSchemaOf(schema: z.ZodType, io: "input" | "output" = "input"): JsonSchema {
    try {
        return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
    } catch (error) {
        log.debug({ error }, "a schema has no JSON Schema form");
        return {};
    }
}

/**
 * A union whose members only add rules to the schema they sit on (`oneOf: [{ required: ["part"] }, …]`, which fields
 * go together) and name no type of their own: the schema's own type is the type.
 */
function constrainsOnly(union: JsonSchema[]): boolean {
    const typed: Array<keyof JsonSchema> = ["type", "properties", "items", "const", "enum", "anyOf", "oneOf", "allOf"];
    return union.every((one) => !("$ref" in one) && typed.every((key) => one[key] === undefined));
}

function literal(value: unknown): string {
    return typeof value === "string" ? `"${value}"` : String(value);
}

/**
 * A compact TypeScript spelling of a JSON Schema, cut to `…` below `depth` levels. A schema with a title (zod
 * `.meta({ title })`) is written as that name, which the API's notes define once (`SourceTime`, `OutputTime`).
 */
export function typeText(schema: JsonSchema, depth = 3): string {
    if (schema.title) {
        return schema.title;
    }

    if (schema.const !== undefined) {
        return literal(schema.const);
    }

    if (schema.enum) {
        return schema.enum.map(literal).join(" | ");
    }

    const union = schema.anyOf ?? schema.oneOf;

    if (union && !constrainsOnly(union)) {
        return [...new Set(union.map((one) => typeText(one, depth)))].join(" | ");
    }

    if (schema.allOf?.length === 1) {
        return typeText(schema.allOf[0], depth);
    }

    const type = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

    if (type.length > 1) {
        return type.map((one) => typeText({ ...schema, type: one }, depth)).join(" | ");
    }

    switch (type[0]) {
        case "string":
            return "string";
        case "integer":
        case "number":
            return `number${rangeText(schema)}`;
        case "boolean":
            return "boolean";
        case "null":
            return "null";
        case "array": {
            if (schema.prefixItems) {
                return `[${schema.prefixItems.map((one) => typeText(one, depth - 1)).join(", ")}]`;
            }

            const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
            const inner = items ? typeText(items, depth - 1) : "unknown";
            return inner.includes(" | ") ? `Array<${inner}>` : `${inner}[]`;
        }
        case "object": {
            const properties = Object.entries(schema.properties ?? {});

            if (properties.length === 0) {
                const extra = schema.additionalProperties;
                return typeof extra === "object" ? `Record<string, ${typeText(extra, depth - 1)}>` : "{}";
            }

            if (depth <= 0) {
                return "{…}";
            }

            const required = new Set(schema.required ?? []);
            const fields = properties.map(([key, value]) => {
                const optional = !required.has(key) || value.default !== undefined;
                return `${key}${optional ? "?" : ""}: ${typeText(value, depth - 1)}`;
            });
            return `{ ${fields.join("; ")} }`;
        }
        default:
            return "unknown";
    }
}

/** Each sub-schema with a title, once, in the order a reader meets them: the named types `typeText` prints by name. */
function namedSchemas(schema: JsonSchema, found: Map<string, JsonSchema>): Map<string, JsonSchema> {
    if (schema.title && !found.has(schema.title)) {
        found.set(schema.title, schema);
    }

    const items = Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : [];
    const extra = typeof schema.additionalProperties === "object" ? [schema.additionalProperties] : [];
    for (const child of [
        ...Object.values(schema.properties ?? {}),
        ...items,
        ...(schema.prefixItems ?? []),
        ...(schema.anyOf ?? []),
        ...(schema.oneOf ?? []),
        ...(schema.allOf ?? []),
        ...extra,
    ]) {
        namedSchemas(child, found);
    }

    return found;
}

/**
 * A schema as TypeScript type declarations: `type <name> = …` for the whole, then one declaration for each titled
 * sub-schema (zod `.meta({ title })`), which the others name instead of repeating it.
 */
export function typeDeclarations(name: string, schema: JsonSchema, depth = 4): string {
    const untitled = (one: JsonSchema): JsonSchema => ({ ...one, title: undefined });
    const named = namedSchemas(untitled(schema), new Map());
    return [
        `type ${name} = ${typeText(untitled(schema), depth)};`,
        ...[...named].map(([title, one]) => `type ${title} = ${typeText(untitled(one), depth)};`),
    ].join("\n");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The paths of the keys in `value` that `schema` does not declare (`$.lines[0].extra`): an object schema with
 * properties declares only those, unless its additionalProperties is a schema; a union takes the member that leaves
 * the fewest. A schema with no type (`{}`, unknown) declares everything below it.
 */
export function undeclaredKeys(value: unknown, schema: JsonSchema, path = "$"): string[] {
    const union = schema.anyOf ?? schema.oneOf;
    if (union?.length) {
        const tries = union.map((member) =>
            undeclaredKeys(value, { ...schema, anyOf: undefined, oneOf: undefined, ...member }, path)
        );
        return tries.reduce((best, one) => (one.length < best.length ? one : best));
    }

    if (Array.isArray(value)) {
        const items = Array.isArray(schema.items) ? undefined : schema.items;
        return items ? value.flatMap((one, index) => undeclaredKeys(one, items, `${path}[${index}]`)) : [];
    }

    if (!isPlainRecord(value)) {
        return [];
    }

    const properties = schema.properties;
    const extra = typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined;
    if (!properties && !extra) {
        return [];
    }

    return Object.entries(value).flatMap(([key, child]) => {
        const declared = properties?.[key] ?? extra;
        if (!declared) {
            return schema.additionalProperties === true ? [] : [`${path}.${key}`];
        }

        return undeclaredKeys(child, declared, `${path}.${key}`);
    });
}

function isEmptyObject(schema: JsonSchema): boolean {
    return schema.type === "object" && Object.keys(schema.properties ?? {}).length === 0;
}

function paramsText(method: MethodDescriptor, depth: number): string {
    const schema = jsonSchemaOf(method.params);

    if (method.positional) {
        const properties = schema.properties ?? {};
        const required = new Set(schema.required ?? []);
        return method.positional
            .map((key) => `${key}${required.has(key) ? "" : "?"}: ${typeText(properties[key] ?? {}, depth)}`)
            .join(", ");
    }

    if (isEmptyObject(schema) || Object.keys(schema).length === 0) {
        return "";
    }

    const optional = (schema.required ?? []).length === 0;
    return `${optional ? "options?" : "options"}: ${typeText(schema, depth)}`;
}

function resultText(method: MethodDescriptor, depth: number): string {
    return method.resultName ?? typeText(jsonSchemaOf(method.result, "output"), depth);
}

/** `recorder.start(options?: { fps?: number }) → Recording` */
export function methodSignature(owner: string, method: MethodDescriptor, depth = 3): string {
    return `${owner}.${method.name}(${paramsText(method, depth)}) → ${resultText(method, depth)}`;
}

function renderMethods(owner: string, methods: readonly MethodDescriptor[]): string[] {
    return methods.map((method) => `- ${methodSignature(owner, method)} [${effectLabel(method)}]\n  ${method.doc}`);
}

function renderHandle(handle: HandleDescriptor): string[] {
    const owner = handle.name.charAt(0).toLowerCase() + handle.name.slice(1);
    return [`${handle.name}: ${handle.summary}`, ...renderMethods(owner, handle.methods)];
}

/** The whole API as `help(name)` prints it. */
export function renderDocs(api: ApiDescriptor): string {
    const lines = [
        `${api.title} (global \`${api.global}\`): ${api.summary}`,
        ...renderMethods(api.global, api.methods),
    ];

    for (const handle of api.handles ?? []) {
        lines.push("", ...renderHandle(handle));
    }

    const methods = [...api.methods, ...(api.handles ?? []).flatMap((handle) => handle.methods)];
    const positional = methods.find((method) => (method.positional?.length ?? 0) > 1);

    if (api.notes?.length || positional) {
        lines.push("", ...(api.notes ?? []).map((note) => `Note: ${note}`));
    }

    if (positional?.positional) {
        // The REPL binding takes both forms (src/utils/repl/toolset.ts); say so once, with a real method.
        const names = positional.positional.join(", ");
        lines.push(
            `Note: a method with positional parameters also takes one object of their names: ${positional.name}(${names}) or ${positional.name}({ ${names} }).`
        );
    }

    return lines.join("\n");
}

export interface McpToolShape {
    name: string;
    description: string;
    inputSchema: { type: "object"; [key: string]: unknown };
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

function objectSchema(schema: Record<string, unknown>): McpToolShape["inputSchema"] {
    return schema.type === "object" ? { ...schema, type: "object" } : { type: "object", ...schema };
}

/** The MCP `tools/list` entries of an API: one tool per method, named after it. */
export function toMcpTools(api: ApiDescriptor): McpToolShape[] {
    return api.methods.map((method) => ({
        name: method.name,
        description: method.doc,
        inputSchema: objectSchema(jsonSchemaOf(method.params)),
        annotations: {
            readOnlyHint: method.effect === "read",
            destructiveHint: method.effect === "destructive",
            openWorldHint: method.mcp?.openWorld ?? (method.effect !== "read" || (method.reaches?.length ?? 0) > 0),
        },
    }));
}
