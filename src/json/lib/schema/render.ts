import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { formatSchema, type OutputMode } from "@app/utils/json-schema";

export type OutputFormat = OutputMode; // "schema" | "skeleton" | "typescript"

export interface RenderOptions {
    /** Raw JSON text (file contents or stdin). */
    text: string;
    /** Output format. */
    format: OutputFormat;
    /** Root interface name (typescript format only; no-op otherwise). */
    name: string;
}

/**
 * Pure: JSON text + flags → formatted schema string.
 * Reads no clock/env/fs/network — deterministic for a given input.
 * Throws on empty or invalid JSON.
 */
export function renderSchema({ text, format, name }: RenderOptions): string {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        throw new Error("No JSON input provided (empty input).");
    }

    let value: unknown;
    try {
        // unbox: true is REQUIRED — the default comment-json parse boxes
        // primitives (String{}/Number{}/Boolean{}), so `typeof` returns
        // "object" and every primitive field is misinferred as an object.
        value = SafeJSON.parse(trimmed, { unbox: true });
    } catch (err) {
        logger.debug({ err }, "infer-schema: JSON parse failed");
        throw new Error(`Invalid JSON input: ${err instanceof Error ? err.message : String(err)}`);
    }

    const output = formatSchema(value, format, { pretty: true });
    return applyRootName(output, format, name);
}

/**
 * Rename the root interface/type for typescript output. No-op for other
 * formats (their formatters have no named root). The util assigns the
 * unsuffixed "Root" to the actual root FIRST via its `uniqueName` counter —
 * a nested key literally named "root" becomes "Root2" — so `\bRoot\b` matches
 * the root token only. The negative lookahead skips matches followed by a
 * (possibly optional) colon — i.e. property keys literally named "Root" — so
 * those are preserved while the `interface Root` declaration and any `: Root;`
 * type-reference are still renamed.
 */
function applyRootName(output: string, format: OutputFormat, name: string): string {
    if (format !== "typescript" || name === "Root") {
        return output;
    }

    return output.replace(/\bRoot\b(?!\s*\??\s*:)/g, () => name);
}
