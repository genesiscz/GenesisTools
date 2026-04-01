/**
 * Shell command fixer — shellwords implementation.
 *
 * Pre-processes with the shared regex pipeline, then uses shellwords' split()
 * to validate that the result is a well-formed command.
 *
 * If split() succeeds the pre-processed string is returned as-is (preserving
 * the original quoting style). If split() throws (e.g. unmatched quote) the
 * pre-processed string is still returned as a best-effort result.
 *
 * Multi-line scripts are returned as-is after pre-processing.
 */

import { split } from "shellwords";
import { preProcess } from "./preprocess.js";

/**
 * Fix a broken shell command string.
 *
 * Never throws — returns best-effort result on any error.
 */
export function fixShellCommand(input: string): string {
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
            // Use shellwords' split() as a parse-validation step.
            // If it throws (unmatched quote, etc.) we fall through to the catch.
            split(text);
        } catch {
            // Parse error — still return the pre-processed string as best effort
        }

        return text;
    } catch {
        return input.replace(/\r/g, "").trim();
    }
}
