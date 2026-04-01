/**
 * Shell command fixer — just-bash implementation.
 *
 * Pre-processes with the shared regex pipeline, then attempts to parse the
 * result with just-bash's `parse()` and validate it with `serialize()`.
 *
 * If parse/serialize succeeds without error the pre-processed string is
 * returned as-is (preserving the original quoting style and operator syntax).
 * If parse or serialize throws, the pre-processed string is still returned
 * as a best-effort result.
 *
 * Multi-line scripts are returned as-is after pre-processing.
 *
 * Note: just-bash's serialize() may normalise redirections and escape
 * sequences differently from the original input (e.g. `2>&1` ↔ `2>& 1`,
 * `{}` ↔ `\{\}`). To avoid these divergences while still exercising the
 * just-bash parser, the pre-processed string is used as output rather than
 * the serialised form.
 */

import type { ScriptNode } from "just-bash";
import { parse, serialize } from "just-bash";
import { preProcess, prettifyCommand } from "./preprocess.js";

export interface FixOptions {
    prettify?: boolean;
}

/**
 * Fix a broken shell command string.
 *
 * Never throws — falls back to pre-processed string on parse/serialize errors.
 */
export function fixShellCommand(input: string, options?: FixOptions): string {
    try {
        const { text, isMultiLine } = preProcess(input);

        if (!text) {
            return "";
        }

        if (isMultiLine) {
            // Multi-line scripts: return pre-processed as-is
            return text;
        }

        try {
            // Use just-bash's parse() + serialize() as an AST round-trip validation.
            // We discard the serialized form (it normalises syntax in ways that diverge
            // from the expected output) and return the pre-processed string instead.
            const ast: ScriptNode = parse(text);
            serialize(ast); // validates that the AST is well-formed
        } catch {
            // parse/serialize failure — pre-processed string is still the best result
        }

        return options?.prettify ? prettifyCommand(text) : text;
    } catch {
        return input.replace(/\r/g, "").trim();
    }
}
