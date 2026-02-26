// src/automate/lib/expressions.ts

import type { ExecutionContext } from "./types.ts";

const EXPR_REGEX = /\{\{\s*(.+?)\s*\}\}/g;

/**
 * Resolve all {{ expressions }} in a string.
 * If the entire string is a single expression that resolves to a non-string,
 * returns the raw value (boolean, number, array, object).
 * Otherwise interpolates all expressions into a string.
 */
export function resolveExpression(template: string, ctx: ExecutionContext): unknown {
    // Fast path: entire string is a single expression
    const fullMatch = template.match(/^\{\{\s*(.+?)\s*\}\}$/);
    if (fullMatch) {
        return evaluateExpression(fullMatch[1], ctx);
    }

    // Multi-expression interpolation: resolve all {{ }} blocks within the string
    return template.replace(EXPR_REGEX, (_match, expr: string) => {
        const result = evaluateExpression(expr.trim(), ctx);
        return String(result ?? "");
    });
}

/**
 * Rewrite hyphenated dot-path segments under vars/steps/env to bracket notation
 * so they are valid JavaScript identifiers inside `new Function`.
 *
 * Example:
 *   steps.my-step.output.count > 0
 *   → steps["my-step"].output.count > 0
 */
function rewriteHyphenatedPaths(expr: string): string {
    return expr.replace(/\b(vars|steps|env)((?:\.[a-zA-Z0-9_-]+)+)/g, (_match, root: string, rest: string) => {
        const segments = rest.slice(1).split(".");
        const rewritten = segments.map((seg) => (seg.includes("-") ? `["${seg}"]` : `.${seg}`));
        // Join: if first segment uses bracket notation, no leading dot needed
        return root + rewritten.join("").replace(/^\./, ".");
    });
}

/**
 * Evaluate a single expression.
 * Examples:
 *   "vars.startDate"                -> ctx.vars.startDate
 *   "steps.search.output.count"     -> ctx.steps.search.output.count
 *   "env.HOME"                      -> ctx.env.HOME
 *   "steps.search.output.count > 0" -> boolean expression via Function()
 */
function evaluateExpression(expr: string, ctx: ExecutionContext): unknown {
    // Fast path: simple dot-property access (vars.x, steps.id.output.field, env.VAR)
    const isSimplePath = /^(vars|steps|env)(\.[a-zA-Z0-9_-]+)+$/.test(expr);
    if (isSimplePath) {
        return resolvePropertyPath(expr, ctx);
    }

    // Complex expression: use Function constructor with sandboxed context
    // Safe for local CLI tool where user writes their own presets
    try {
        // Rewrite hyphenated path segments to bracket notation before passing to
        // new Function, because `steps.my-step.output` parses as subtraction there.
        // e.g. steps.my-step.output.count > 0 → steps["my-step"].output.count > 0
        const rewritten = rewriteHyphenatedPaths(expr);
        const fn = new Function("vars", "steps", "env", `return (${rewritten});`);
        return fn(ctx.vars, ctx.steps, ctx.env);
    } catch (error) {
        throw new Error(
            `Expression evaluation failed: "{{ ${expr} }}" - ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Resolve a dot-separated property path against the context.
 * "steps.search.output.ids" -> ctx.steps.search.output.ids
 */
function resolvePropertyPath(path: string, ctx: ExecutionContext): unknown {
    const parts = path.split(".");
    let current: unknown = ctx;

    for (const part of parts) {
        if (current === null || current === undefined) {
            return undefined;
        }
        if (typeof current === "object") {
            current = (current as Record<string, unknown>)[part];
        } else {
            return undefined;
        }
    }

    return current;
}

/**
 * Resolve all expressions in a params object.
 * Returns a new object with all string values resolved.
 * Non-string values (numbers, booleans) pass through unchanged.
 * Arrays have each string element resolved.
 * Nested objects are resolved recursively.
 */
export function resolveParams(params: Record<string, unknown>, ctx: ExecutionContext): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
        if (typeof value === "string") {
            resolved[key] = resolveExpression(value, ctx);
        } else if (Array.isArray(value)) {
            resolved[key] = value.map((v) => (typeof v === "string" ? resolveExpression(v, ctx) : v));
        } else if (value !== null && typeof value === "object") {
            resolved[key] = resolveParams(value as Record<string, unknown>, ctx);
        } else {
            resolved[key] = value;
        }
    }

    return resolved;
}
