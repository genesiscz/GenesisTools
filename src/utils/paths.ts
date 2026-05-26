/**
 * Cross-platform path helpers.
 * Handles tilde expansion, separator detection, and path resolution
 * that work correctly on both Unix and Windows.
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { collapsePathForDisplay as collapsePathHeuristic } from "./paths.client";

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
 * Replace the user's home directory prefix with `~`.
 * Inverse of `expandTilde()`.
 */
export function collapsePath(p: string): string {
    const home = homedir();
    const homeNorm = endsWithSep(home) ? home.slice(0, -1) : home;

    if (p === homeNorm) {
        return "~";
    }

    const unixPrefix = `${homeNorm}/`;
    if (p.startsWith(unixPrefix)) {
        return `~/${p.slice(unixPrefix.length)}`;
    }

    const winPrefix = `${homeNorm}\\`;
    if (p.startsWith(winPrefix)) {
        return `~/${p.slice(winPrefix.length)}`;
    }

    return p;
}

/**
 * Collapse home for display in browser or Node. Uses `collapsePath()` when
 * `homedir()` is available; otherwise falls back to `/Users/*` / `/home/*` heuristics.
 */
export function collapsePathForDisplay(p: string): string {
    if (!p) {
        return p;
    }

    const normalized = toPosixPath(p);

    if (normalized.startsWith("~/") || normalized === "~") {
        return normalized;
    }

    try {
        const home = homedir();
        if (home) {
            const collapsed = collapsePath(normalized);
            if (collapsed !== normalized) {
                return collapsed;
            }

            return normalized;
        }
    } catch {
        // Browser bundle — no homedir.
    }

    return collapsePathHeuristic(normalized);
}

/**
 * The platform's path separator (re-exported for convenience).
 */
export { sep };

/**
 * Normalize a path to POSIX separators (`\` → `/`).
 *
 * Use whenever a path is compared, used as a Map/object key, hashed, or
 * emitted as stable output (merkle trees, code graphs, file-source keys,
 * snapshots). On Windows `path.join`/`relative` yield `src\a.ts`; without
 * this they don't match the `src/a.ts` the rest of the code/tests assume,
 * which is the entire path-separator failure cluster.
 *
 * For filesystem *access* keep the native path — only normalize the
 * logical/string form used for identity or display.
 */
export function toPosixPath(p: string): string {
    return p.replace(/\\/g, "/");
}

export interface TmpdirOptions {
    /**
     * On macOS/Linux, prefer the short, stable `/tmp` root over the per-user
     * `$TMPDIR`. On macOS `os.tmpdir()` is `/var/folders/<…>/T` — long and,
     * under parallel test load, the source of the path-length / churn
     * failures in the cross-platform inventory. Defaults to `true`.
     *
     * No-op on Windows: there is no `/tmp`, so `os.tmpdir()`
     * (`%TEMP%`, e.g. `C:\Users\…\AppData\Local\Temp`) is always used.
     */
    preferRoot?: boolean;
}

/**
 * Cross-platform temp directory root. ALWAYS get temp paths through this
 * (or {@link tmpPath} / {@link makeTempDir}) — never `os.tmpdir()` or a
 * literal `"/tmp"` at a callsite — so platform quirks stay in one place.
 *
 * - macOS/Linux, `preferRoot` (default): `/tmp`
 * - macOS/Linux, `preferRoot: false`:   `os.tmpdir()` (`$TMPDIR`)
 * - Windows (any value):                `os.tmpdir()` (no `/tmp` on Windows)
 */
export function tmpdir(options: TmpdirOptions = {}): string {
    const { preferRoot = true } = options;

    if (preferRoot && process.platform !== "win32") {
        return "/tmp";
    }

    return osTmpdir();
}

/**
 * Join segments under the temp root.
 * `tmpPath("genesis", "x.db")` → `/tmp/genesis/x.db` (macOS/Linux) or
 * `C:\…\Temp\genesis\x.db` (Windows). For `preferRoot: false`, use
 * `join(tmpdir({ preferRoot: false }), …)`.
 */
export function tmpPath(...segments: string[]): string {
    return join(tmpdir(), ...segments);
}

/**
 * `mkdtemp` a unique temp directory under the temp root and return its
 * absolute path. `makeTempDir("genesis-test-")` → `/tmp/genesis-test-AbC123`.
 * The prefix should normally end with `-`.
 */
export function makeTempDir(prefix: string, options?: TmpdirOptions): string {
    return mkdtempSync(join(tmpdir(options), prefix));
}
