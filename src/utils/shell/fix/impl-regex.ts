/**
 * Shell command fixer — pure regex implementation (no dependencies).
 *
 * Delegates entirely to the shared pre-processing pipeline.
 */

import { preProcess } from "./preprocess.js";

/**
 * Fix a broken shell command string using regex/string manipulation only.
 *
 * Never throws — returns best-effort result on any error.
 */
export function fixShellCommand(input: string): string {
    try {
        return preProcess(input).text;
    } catch {
        return input.replace(/\r/g, "").trim();
    }
}
