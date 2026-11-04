import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import type { ApiDescriptor, HandleDescriptor, MethodDescriptor } from "./descriptor";

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
};

/** The JSON Schema of one side of a schema; `{}` (any) where zod cannot express it (a function, a custom type). */
export function jsonSchemaOf(schema: z.ZodType, io: "input" | "output" = "input"): JsonSchema {
    try {
        return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
    } catch (error) {
        log.debug({ error }, "a schema has no JSON Schema form");
        return {};
    }
}

function literal(value: unknown): string {
    return typeof value === "string" ? `"${value}"` : String(value);
}

/** A compact TypeScript spelling of a JSON Schema, cut to `…` below `depth` levels. */
export function typeText(schema: JsonSchema, depth = 3): string {
    if (schema.const !== undefined) {
        return literal(schema.const);
    }

    if (schema.enum) {
        return schema.enum.map(literal).join(" | ");
    }

    const union = schema.anyOf ?? schema.oneOf;

    if (union) {
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
            return "number";
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

function paramKeys(method: MethodDescriptor): string {
    if (method.positional) {
        return method.positional.join(", ");
    }

    const schema = jsonSchemaOf(method.params);
    const keys = Object.keys(schema.properties ?? {});
    return keys.length === 0 ? "" : `{${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""}}`;
}

/** One line for a tool description: the global, its summary, and each method with its parameter names. */
export function renderOneLine(api: ApiDescriptor): string {
    const methods = api.methods.map((method) => `${api.global}.${method.name}(${paramKeys(method)})`).join(", ");
    return `${api.global}: ${api.summary} ${methods}`;
}

function renderMethods(owner: string, methods: readonly MethodDescriptor[]): string[] {
    return methods.map((method) => `- ${methodSignature(owner, method)} [${method.effect}]\n  ${method.doc}`);
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

    if (api.notes?.length) {
        lines.push("", ...api.notes.map((note) => `Note: ${note}`));
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
            openWorldHint: method.mcp?.openWorld ?? method.effect !== "read",
        },
    }));
}
