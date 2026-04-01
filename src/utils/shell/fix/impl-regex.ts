/**
 * Shell command fixer — pure regex implementation (no dependencies).
 *
 * Delegates entirely to the shared pre-processing pipeline.
 */

import { preProcess, prettifyCommand } from "./preprocess.js";

export interface FixOptions {
    prettify?: boolean;
}

/**
 * Fix a broken shell command string using regex/string manipulation only.
 *
 * Never throws — returns best-effort result on any error.
 */
export function fixShellCommand(input: string, options?: FixOptions): string {
    try {
        const result = preProcess(input).text;
        return options?.prettify ? prettifyCommand(result) : result;
    } catch {
        return input.replace(/\r/g, "").trim();
    }
}
