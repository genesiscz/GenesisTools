import { parseSync } from "oxc-parser";

interface Span {
    start: number;
    end: number;
}

interface AstNode {
    type?: string;
    start?: number;
    end?: number;
    computed?: boolean;
    shorthand?: boolean;
    key?: unknown;
    [key: string]: unknown;
}

const PROPERTY_TYPES = new Set(["Property", "ObjectProperty", "BindingProperty"]);

const IDENTIFIER_TYPES = new Set(["Identifier", "IdentifierReference", "BindingIdentifier"]);
const SKIP_KEY_BY_PARENT: Record<string, string> = {
    MemberExpression: "property",
    StaticMemberExpression: "property",
    Property: "key",
    ObjectProperty: "key",
    PropertyDefinition: "key",
    MethodDefinition: "key",
};

/**
 * Replaces every identifier binding/reference with "ID" while preserving property names,
 * non-computed object keys, string literals, and line structure. This collapses minifier
 * name-churn so beautified bundles from different builds diff cleanly.
 */
export function normalizeIdentifiers(source: string, filename = "bundle.js"): string {
    const parsed = parseSync(filename, source);

    if (parsed.errors.length > 0) {
        throw new Error(
            `normalize: parse failed with ${parsed.errors.length} errors (first: ${parsed.errors[0]?.message})`
        );
    }

    const spans: Span[] = [];
    // Shorthand `{ foo }` uses one span for both key and value; rewriting it would hide
    // the (semantic) property name, so identifiers on these exact spans are preserved.
    const shorthandKeySpans = new Set<string>();
    const stack: AstNode[] = [parsed.program as unknown as AstNode];

    while (stack.length > 0) {
        const node = stack.pop();

        if (!node || typeof node !== "object") {
            continue;
        }

        if (Array.isArray(node)) {
            for (const child of node) {
                stack.push(child as AstNode);
            }

            continue;
        }

        const type = node.type;

        if (
            type !== undefined &&
            IDENTIFIER_TYPES.has(type) &&
            typeof node.start === "number" &&
            typeof node.end === "number"
        ) {
            if (!shorthandKeySpans.has(`${node.start}:${node.end}`)) {
                spans.push({ start: node.start, end: node.end });
            }

            continue;
        }

        if (type !== undefined && PROPERTY_TYPES.has(type) && node.shorthand === true) {
            const key = node.key as AstNode | null | undefined;

            if (key && typeof key.start === "number" && typeof key.end === "number") {
                shorthandKeySpans.add(`${key.start}:${key.end}`);
            }
        }

        const skipKey = type !== undefined ? SKIP_KEY_BY_PARENT[type] : undefined;

        for (const key in node) {
            if (key === "type" || key === "start" || key === "end") {
                continue;
            }

            if (skipKey === key && node.computed !== true) {
                continue;
            }

            const value = node[key];

            if (value !== null && typeof value === "object") {
                stack.push(value as AstNode);
            }
        }
    }

    spans.sort((a, b) => a.start - b.start);
    const parts: string[] = [];
    let pos = 0;

    for (const span of spans) {
        if (span.start < pos) {
            continue;
        }

        parts.push(source.slice(pos, span.start), "ID");
        pos = span.end;
    }

    parts.push(source.slice(pos));
    return parts.join("");
}
