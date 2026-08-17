/**
 * JSON Schema to TypeScript source text.
 *
 * WHY THIS EXISTS RATHER THAN `mcporter emit-ts`
 *
 * mcporter ships its own codegen and it was the obvious thing to reuse. It was
 * tested against a real server (2026-07-28, mcporter 0.12.3) and rejected for
 * two concrete reasons:
 *
 * 1. Its output does not compile. It emits POSITIONAL parameters in schema
 *    order, so any tool whose schema lists an optional property before a
 *    required one produces `TS1016: A required parameter cannot follow an
 *    optional parameter`. Real example from `mcporter emit-ts genesis-tools`:
 *      handoff_post(title: string, description?: string, tasks: Record<string, unknown>[], ...)
 *    Two occurrences in that one file.
 * 2. It flattens nested objects to `Record<string, unknown>`, so the part most
 *    worth typing (`tasks[].acceptanceCriteria`, `target.sessionId`) is lost.
 *
 * MCP tools take a single arguments OBJECT, so the object form is also the
 * shape that matches the protocol. Its emit is additionally one-server-per-file
 * and reads mcporter's own config discovery rather than the mcp-manager
 * registry this skill is built on.
 *
 * mcporter's RUNTIME is still doing the real work (transport, connection
 * caching, OAuth, and `createCallResult` for result unwrapping in kit.ts).
 * This module replaces only the emit half. Re-evaluate when mcporter fixes the
 * parameter ordering.
 *
 * Scope is deliberately small: what MCP servers actually put in `inputSchema`
 * and `outputSchema`. That is objects, primitives, arrays, enums, unions and
 * `$ref` into `$defs`/`definitions`. Anything unrecognised degrades to
 * `unknown` rather than guessing, because a wrong type here is worse than none.
 */
import { SafeJSON } from "@genesiscz/utils/json";

interface Schema {
    type?: string | string[];
    description?: string;
    properties?: Record<string, Schema>;
    required?: string[];
    items?: Schema | Schema[];
    enum?: unknown[];
    const?: unknown;
    anyOf?: Schema[];
    oneOf?: Schema[];
    allOf?: Schema[];
    additionalProperties?: boolean | Schema;
    $ref?: string;
    $defs?: Record<string, Schema>;
    definitions?: Record<string, Schema>;
    [key: string]: unknown;
}

const INDENT = "    ";

function isSchema(value: unknown): value is Schema {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string {
    if (typeof value === "string") {
        return SafeJSON.stringify(value, { strict: true });
    }

    if (typeof value === "number" || typeof value === "boolean" || value === null) {
        return String(value);
    }

    return "unknown";
}

/** A JS identifier can stay bare; anything else gets quoted. */
function propKey(name: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : SafeJSON.stringify(name, { strict: true });
}

function resolveRef(ref: string, root: Schema): Schema | undefined {
    const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);

    if (!match) {
        return undefined;
    }

    const bucket = (root[match[1] as "$defs"] ?? {}) as Record<string, Schema>;
    return bucket[match[2]!];
}

function primitive(type: string): string {
    switch (type) {
        case "string":
            return "string";
        case "number":
        case "integer":
            return "number";
        case "boolean":
            return "boolean";
        case "null":
            return "null";
        case "array":
            return "unknown[]";
        case "object":
            return "Record<string, unknown>";
        default:
            return "unknown";
    }
}

function render(schema: Schema | undefined, root: Schema, depth: number, seen: Set<Schema>): string {
    if (!schema || !isSchema(schema)) {
        return "unknown";
    }

    if (seen.has(schema) || depth > 8) {
        return "unknown";
    }

    if (schema.$ref) {
        const target = resolveRef(schema.$ref, root);
        return target ? render(target, root, depth + 1, new Set([...seen, schema])) : "unknown";
    }

    if (schema.const !== undefined) {
        return literal(schema.const);
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum.map(literal).join(" | ");
    }

    const union = schema.anyOf ?? schema.oneOf;

    if (Array.isArray(union) && union.length > 0) {
        const parts = union.map((s) => render(s, root, depth + 1, new Set([...seen, schema])));
        return [...new Set(parts)].join(" | ");
    }

    if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
        const parts = schema.allOf.map((s) => render(s, root, depth + 1, new Set([...seen, schema])));
        return parts.join(" & ");
    }

    if (Array.isArray(schema.type)) {
        return [...new Set(schema.type.map(primitive))].join(" | ");
    }

    if (schema.type === "array" || schema.items) {
        // Legacy tuple form: one schema per position. Collapsing to the first
        // item would type `[string, number]` as `string[]`.
        if (Array.isArray(schema.items)) {
            const parts = schema.items.map((s) => render(s, root, depth + 1, new Set([...seen, schema])));
            return `[${parts.join(", ")}]`;
        }

        const inner = render(schema.items, root, depth + 1, new Set([...seen, schema]));
        return inner.includes(" ") && !inner.startsWith("{") ? `(${inner})[]` : `${inner}[]`;
    }

    if (schema.type === "object" || schema.properties) {
        const props = schema.properties ?? {};
        const entries = Object.entries(props);

        if (entries.length === 0) {
            return "Record<string, unknown>";
        }

        const required = new Set(schema.required ?? []);
        const pad = INDENT.repeat(depth + 1);
        const closePad = INDENT.repeat(depth);
        const lines: string[] = ["{"];

        for (const [name, propSchema] of entries) {
            const rendered = render(propSchema, root, depth + 1, new Set([...seen, schema]));
            const doc = typeof propSchema?.description === "string" ? propSchema.description.trim() : "";

            if (doc) {
                lines.push(`${pad}/** ${doc.replace(/\*\//g, "*\\/").replace(/\s+/g, " ")} */`);
            }

            lines.push(`${pad}${propKey(name)}${required.has(name) ? "" : "?"}: ${rendered};`);
        }

        if (schema.additionalProperties) {
            lines.push(`${pad}[key: string]: unknown;`);
        }

        lines.push(`${closePad}}`);
        return lines.join("\n");
    }

    if (typeof schema.type === "string") {
        return primitive(schema.type);
    }

    return "unknown";
}

/** Render a JSON Schema as an inline TypeScript type. */
export function schemaToType(schema: unknown, depth = 0): string {
    if (!isSchema(schema)) {
        return "Record<string, unknown>";
    }

    return render(schema, schema, depth, new Set());
}

/** True when the schema has no properties, i.e. the tool takes no arguments. */
export function isEmptySchema(schema: unknown): boolean {
    if (!isSchema(schema)) {
        return true;
    }

    const props = schema.properties;
    return !props || Object.keys(props).length === 0;
}

/** True when every property is optional, so the whole args object can be. */
export function allOptional(schema: unknown): boolean {
    if (!isSchema(schema)) {
        return true;
    }

    return (schema.required ?? []).length === 0;
}
