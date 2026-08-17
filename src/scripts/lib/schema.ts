/**
 * Shape instead of data.
 *
 * The cheapest useful thing to say about a 500KB JSON payload is what shape it
 * has. An agent that can see `{ id: number, items: [{ title: string }] }` knows
 * whether it needs the real data at all, and which part — for the cost of one
 * line instead of the whole document.
 *
 * Ported from the pattern GenesisTools' har-analyzer and debugging-master use
 * (`src/utils/json-schema.ts`), where it backs `expand --schema`.
 *
 * Array items are UNIONED rather than sampled: an array of 10,000 objects whose
 * 700th element has an extra optional field still reports that field. Sampling
 * the first element is the obvious shortcut and it silently lies.
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export type SchemaMode = "skeleton" | "typescript" | "schema";

type Primitive = "string" | "number" | "boolean" | "null" | "undefined";

export type Shape =
    | { kind: "primitive"; type: Primitive }
    | { kind: "array"; items: Shape | undefined; length: number }
    | { kind: "object"; fields: Map<string, { shape: Shape; optional: boolean }> }
    | { kind: "union"; options: Shape[] };

const MAX_DEPTH = 12;

function primitiveOf(value: unknown): Primitive {
    if (value === null) {
        return "null";
    }

    if (value === undefined) {
        return "undefined";
    }

    const type = typeof value;
    return type === "string" || type === "number" || type === "boolean" ? type : "string";
}

function sameShape(a: Shape, b: Shape): boolean {
    if (a.kind !== b.kind) {
        return false;
    }

    // The primitive-vs-primitive case dominates when merging large arrays;
    // rendering both subtrees to strings there would make the "cheap summary"
    // module quadratic on exactly the payloads it exists to summarize.
    if (a.kind === "primitive" && b.kind === "primitive") {
        return a.type === b.type;
    }

    return render(a, "skeleton", 0) === render(b, "skeleton", 0);
}

/** Collapse two shapes into one, widening to a union only when they differ. */
export function mergeShapes(a: Shape | undefined, b: Shape | undefined): Shape | undefined {
    if (!a) {
        return b;
    }

    if (!b) {
        return a;
    }

    if (a.kind === "object" && b.kind === "object") {
        const fields = new Map(a.fields);

        for (const [key, right] of b.fields) {
            const left = fields.get(key);
            fields.set(
                key,
                left
                    ? { shape: mergeShapes(left.shape, right.shape)!, optional: left.optional || right.optional }
                    : { shape: right.shape, optional: true }
            );
        }

        // A key absent from b is optional across the union.
        for (const [key, left] of a.fields) {
            if (!b.fields.has(key)) {
                fields.set(key, { ...left, optional: true });
            }
        }

        return { kind: "object", fields };
    }

    if (a.kind === "array" && b.kind === "array") {
        return { kind: "array", items: mergeShapes(a.items, b.items), length: a.length + b.length };
    }

    if (sameShape(a, b)) {
        return a;
    }

    const options = [...(a.kind === "union" ? a.options : [a]), ...(b.kind === "union" ? b.options : [b])];
    const unique: Shape[] = [];

    for (const option of options) {
        if (!unique.some((u) => sameShape(u, option))) {
            unique.push(option);
        }
    }

    return unique.length === 1 ? unique[0]! : { kind: "union", options: unique };
}

export function inferShape(value: unknown, depth = 0): Shape {
    if (depth >= MAX_DEPTH) {
        return { kind: "primitive", type: "string" };
    }

    if (Array.isArray(value)) {
        let items: Shape | undefined;

        for (const entry of value) {
            items = mergeShapes(items, inferShape(entry, depth + 1));
        }

        return { kind: "array", items, length: value.length };
    }

    if (value !== null && typeof value === "object") {
        const fields = new Map<string, { shape: Shape; optional: boolean }>();

        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            fields.set(key, { shape: inferShape(entry, depth + 1), optional: false });
        }

        return { kind: "object", fields };
    }

    return { kind: "primitive", type: primitiveOf(value) };
}

function indent(level: number): string {
    return "  ".repeat(level);
}

function render(shape: Shape, mode: SchemaMode, level: number): string {
    switch (shape.kind) {
        case "primitive":
            return shape.type;
        case "union":
            return shape.options.map((o) => render(o, mode, level)).join(" | ");
        case "array": {
            if (!shape.items) {
                return "[]";
            }

            return `[${render(shape.items, mode, level)}]`;
        }
        case "object": {
            if (shape.fields.size === 0) {
                return "{}";
            }

            const inline = mode === "skeleton" && shape.fields.size <= 3;
            const parts = [...shape.fields].map(
                ([key, { shape: field, optional }]) => `${key}${optional ? "?" : ""}: ${render(field, mode, level + 1)}`
            );

            if (inline) {
                return `{ ${parts.join(", ")} }`;
            }

            return `{\n${parts.map((p) => `${indent(level + 1)}${p}`).join(",\n")}\n${indent(level)}}`;
        }
    }
}

function singular(name: string): string {
    if (name.endsWith("ies")) {
        return `${name.slice(0, -3)}y`;
    }

    return name.endsWith("s") && !name.endsWith("ss") ? name.slice(0, -1) : name;
}

function pascal(name: string): string {
    return name
        .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
        .replace(/^[a-z]/, (c) => c.toUpperCase());
}

/**
 * Named interfaces rather than one nested literal.
 *
 * A nested object under `items` becomes `Item`, so a reader can talk about the
 * pieces by name instead of by path.
 */
function renderTypescript(shape: Shape, rootName: string): string {
    const emitted: string[] = [];
    const seen = new Map<string, string>();
    const used = new Set<string>();

    function walk(current: Shape, name: string, level: number): string {
        if (current.kind === "array") {
            return current.items ? `${walk(current.items, singular(name), level)}[]` : "unknown[]";
        }

        if (current.kind === "union") {
            return current.options.map((o) => walk(o, name, level)).join(" | ");
        }

        if (current.kind === "primitive") {
            return current.type === "undefined" ? "undefined" : current.type;
        }

        const body = [...current.fields]
            .map(
                ([key, { shape: field, optional }]) =>
                    `  ${tsKey(key)}${optional ? "?" : ""}: ${walk(field, key, level + 1)};`
            )
            .join("\n");
        const base = typeNameOf(name);
        const existing = seen.get(`${base}\n${body}`);

        if (existing) {
            return existing;
        }

        // Two DIFFERENT shapes can resolve to the same name (`item` and the
        // element of `items` both become `Item`); a numeric suffix keeps the
        // advertised-as-pasteable output compiling.
        let typeName = base;
        let n = 2;

        while (used.has(typeName)) {
            typeName = `${base}${n}`;
            n += 1;
        }

        used.add(typeName);
        seen.set(`${base}\n${body}`, typeName);
        emitted.push(`interface ${typeName} {\n${body}\n}`);
        return typeName;
    }

    const root = walk(shape, rootName, 0);

    if (emitted.length === 0) {
        return `type ${typeNameOf(rootName)} = ${root};`;
    }

    const declarations = emitted.reverse();

    // An array-of-objects payload emits `interface Item` but the root IS
    // `Item[]`; without a root alias the pasteable output cannot name the
    // top-level value.
    if (!used.has(root)) {
        declarations.push(`type ${typeNameOf(rootName)} = ${root};`);
    }

    return declarations.join("\n\n");
}

/** JSON allows keys (`content-type`, `first name`, `2fa`) that are not valid TS identifiers; quote those. */
function tsKey(key: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : SafeJSON.stringify(key, { strict: true });
}

/** A key like `2fa` pascals to `2fa`, which is not a legal interface name; strip the digits and re-case, falling back to Root. */
function typeNameOf(name: string): string {
    const stripped = pascal(name).replace(/^[0-9]+/, "");
    return stripped ? `${stripped.charAt(0).toUpperCase()}${stripped.slice(1)}` : "Root";
}

function toJsonSchema(shape: Shape): unknown {
    switch (shape.kind) {
        case "primitive":
            return { type: shape.type === "undefined" ? "null" : shape.type };
        case "union":
            return { anyOf: shape.options.map(toJsonSchema) };
        case "array":
            return { type: "array", items: shape.items ? toJsonSchema(shape.items) : {} };
        case "object": {
            const properties: Record<string, unknown> = {};
            const required: string[] = [];

            for (const [key, { shape: field, optional }] of shape.fields) {
                properties[key] = toJsonSchema(field);

                if (!optional) {
                    required.push(key);
                }
            }

            return required.length > 0 ? { type: "object", properties, required } : { type: "object", properties };
        }
    }
}

export interface FormatSchemaOptions {
    /** Name for the root type in `typescript` mode. */
    rootName?: string;
}

/**
 * The shape of a value, in one of three registers.
 *
 * `skeleton` reads fastest, `typescript` is pasteable into code, `schema` is
 * machine-comparable. A string that parses as JSON is treated as its parsed
 * value, since MCP servers routinely hand back JSON in a text block.
 */
export function formatSchema(value: unknown, mode: SchemaMode = "skeleton", options: FormatSchemaOptions = {}): string {
    let subject = value;

    if (typeof value === "string") {
        subject = safeParse(value);

        if (subject === undefined) {
            return "string";
        }
    }

    const shape = inferShape(subject);

    if (mode === "typescript") {
        return renderTypescript(shape, options.rootName ?? "Root");
    }

    if (mode === "schema") {
        return SafeJSON.stringify(toJsonSchema(shape), { strict: true }, 2);
    }

    return render(shape, "skeleton", 0);
}

/** One-line census of an array-of-objects: how many, and which keys are not always present. */
export function describeCollection(value: unknown): string | undefined {
    const subject = typeof value === "string" ? safeParse(value) : value;

    if (!Array.isArray(subject) || subject.length === 0) {
        return undefined;
    }

    const shape = inferShape(subject);

    if (shape.kind !== "array" || shape.items?.kind !== "object") {
        return undefined;
    }

    const optional = [...shape.items.fields].filter(([, f]) => f.optional).map(([k]) => k);
    const total = shape.items.fields.size;

    return `${subject.length} item(s), ${total} field(s)${optional.length > 0 ? `, sometimes-missing: ${optional.join(", ")}` : ""}`;
}

function safeParse(value: string): unknown {
    try {
        return SafeJSON.parse(value, { strict: true });
    } catch (error) {
        logger.debug({ error }, "value is not JSON; treating as plain string");
        return undefined;
    }
}
