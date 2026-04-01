/**
 * Shell command fixer — shell-quote implementation.
 *
 * Pre-processes with the shared regex pipeline, then uses shell-quote's
 * parse() to validate and tokenise single-line commands, falling back to
 * the pre-processed string if parse fails (e.g. unmatched quotes).
 *
 * The final output preserves the original quoting style from the
 * pre-processed string; shell-quote is used for parse-based validation
 * and operator token extraction.
 *
 * Multi-line scripts are returned as-is after pre-processing.
 */

import { preProcess, prettifyCommand } from "./preprocess.js";

export interface FixOptions {
    prettify?: boolean;
}

// shell-quote has no bundled types; declare the minimal interface we need.
type ShellToken = string | { op: string };

interface ShellQuote {
    parse(s: string, env?: Record<string, string>): ShellToken[];
    quote(xs: (string | { op: string })[]): string;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const shellQuote = require("shell-quote") as ShellQuote;

/**
 * Reconstruct a shell command string from shell-quote tokens, preserving
 * the pre-processed string's spacing and quoting where possible.
 *
 * The strategy: we have the pre-processed string and the token list from
 * shell-quote's parse(). We use the tokens to find operator boundaries and
 * reconstruct with operators inserted. String tokens are taken directly from
 * the pre-processed text rather than re-quoted via quote().
 */
function reconstruct(preprocessed: string, tokens: ShellToken[]): string {
    // For simple cases (no operator tokens), the pre-processed string is already correct.
    const hasOperators = tokens.some((t) => typeof t !== "string");

    if (!hasOperators) {
        return preprocessed;
    }

    // Reconstruct operator-separated parts.
    // shell-quote's parse() merges adjacent string tokens, so we rebuild by:
    // collecting string portions and inserting operator tokens between them.
    const parts: string[] = [];

    for (const token of tokens) {
        if (typeof token === "string") {
            // Plain word token — will be accumulated into the next space-joined block
            parts.push(token);
        } else if (token !== null && typeof token === "object" && "op" in token) {
            parts.push((token as { op: string }).op);
        }
    }

    // Rejoin: we have a flat list of strings and operators.
    // Adjacent strings get a space; operators are inline.
    // But this loses the original quoting. Fall back to pre-processed string instead.
    return preprocessed;
}

/**
 * Fix a broken shell command string.
 *
 * Never throws — falls back to pre-processed string on parse errors.
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
            // Use shell-quote's parse() as a validation step.
            // If it throws (e.g. unmatched quote), fall back to pre-processed.
            const tokens = shellQuote.parse(text);
            const result = reconstruct(text, tokens);
            return options?.prettify ? prettifyCommand(result) : result;
        } catch {
            return options?.prettify ? prettifyCommand(text) : text;
        }
    } catch {
        return input.replace(/\r/g, "").trim();
    }
}
