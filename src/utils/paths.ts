/**
 * Cross-platform path helpers.
 * Handles tilde expansion, separator detection, and path resolution
 * that work correctly on both Unix and Windows.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Whether a path string ends with a directory separator (/ or \).
 */
export function endsWithSep(p: string): boolean {
    return p.endsWith("/") || p.endsWith("\\");
}

/**
 * Index of the last directory separator (/ or \) in a path string.
 * Returns -1 if no separator is found.
 */
export function lastSepIndex(p: string): number {
    return Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
}

/**
 * Expand a leading `~` to the user's home directory.
 * Handles both `~/` (Unix) and `~\` (Windows).
 * Returns the path unchanged if it doesn't start with `~`.
 */
export function expandTilde(p: string): string {
    if (p === "~") {
        return homedir();
    }

    if (p.startsWith("~/") || p.startsWith("~\\")) {
        return join(homedir(), p.slice(2));
    }

    return p;
}

/**
 * Resolve a path string to an absolute path.
 * Handles `~/`, `~\`, `./`, relative paths, and absolute paths.
 */
export function expandPath(p: string): string {
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
        return expandTilde(p);
    }

    if (p.startsWith("./") || p.startsWith(".\\")) {
        return resolve(process.cwd(), p.slice(2));
    }

    if (!isAbsolute(p)) {
        return resolve(process.cwd(), p);
    }

    return p;
}

/**
 * Absolute path to the GenesisTools project root (where package.json lives).
 */
export const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

/**
 * The platform's path separator (re-exported for convenience).
 */
export { sep };
