/**
 * Cross-platform path helpers.
 * Handles tilde expansion, separator detection, and path resolution
 * that work correctly on both Unix and Windows.
 */

import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { env } from "./env.client";
import { SafeJSON } from "./json";
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
 * `realpath` of the deepest ancestor that resolves, with the unresolvable tail appended.
 *
 * A path that does not exist yet still has to canonicalize, and returning it untouched is not
 * good enough: `~/.claude/` under a symlinked home would then compare unequal to the same
 * directory once it exists, which is the whole failure {@link canonicalPath} removes. Walking
 * up gives the missing path the SAME prefix its existing siblings get.
 *
 * Every errno stops the walk, not just ENOENT. This function's only job is to produce a
 * comparable spelling; a caller asking "are these the same home?" over a list of rows can do
 * nothing with an EACCES or ENOTDIR thrown from the middle of it except fail the whole list.
 * A path nothing in the chain resolves comes back resolved-but-not-realpath'd, which every
 * other unreadable path under the same root also does, so they still compare consistently.
 */
function realpathDeepest(absolute: string): string {
    const tail: string[] = [];
    let current = absolute;

    for (;;) {
        try {
            const resolved = realpathSync(current);

            return tail.length > 0 ? join(resolved, ...tail) : resolved;
        } catch {
            // Unreadable for any reason — try this component's parent. See the note above:
            // throwing here would abort a caller that is only comparing strings.
        }

        const parent = dirname(current);

        if (parent === current) {
            return absolute;
        }

        tail.unshift(basename(current));
        current = parent;
    }
}

/**
 * The one spelling of a directory that two paths can be compared on.
 *
 * `~`, a trailing slash, a `..` segment, a relative value and a symlink all name the same home
 * while comparing unequal as strings. Anything asking "are these the same home?" must go through
 * this, or the comparison silently answers no and whatever it guarded becomes a no-op.
 *
 * 🛑 Every input gets the SAME normalization, whether or not it exists and whether or not it is
 * readable. Two values this returns are always comparable with each other. An earlier version
 * returned the merely-expanded string for a missing path and threw on any other errno, so a
 * trailing slash, a symlinked ancestor and `/tmp` vs `/private/tmp` all survived on that branch
 * and the two branches could never match — the no-op this function exists to prevent.
 */
export function canonicalPath(p: string): string {
    // `resolve` is what makes the branches comparable: it makes the value absolute, collapses
    // `.` and `..`, and drops a trailing separator. `expandPath` does none of those.
    return realpathDeepest(resolve(expandPath(p)));
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

    if (p.startsWith("~/") || p === "~" || p === "~\\" || p.startsWith("~\\")) {
        return toPosixPath(p);
    }

    try {
        const home = homedir();
        if (home) {
            // Collapse against the ORIGINAL native path — collapsePath()
            // does both unix and Windows home-prefix checks internally,
            // and `homedir()` returns the native form. On Windows the
            // input is typically `C:\Users\name\foo` and home is
            // `C:\Users\name`; pre-normalizing to POSIX first would break
            // the prefix match (the prior bug).
            const collapsed = collapsePath(p);
            const displayCollapsed = toPosixPath(collapsed);
            if (collapsed !== p) {
                return displayCollapsed;
            }

            return toPosixPath(p);
        }
    } catch {
        // Browser bundle — no homedir.
    }

    return collapsePathHeuristic(toPosixPath(p));
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

    // Inside a test run this wins over both branches below. The preload gives each test
    // process a temp root it removes at exit by pointing TMPDIR at it, but the `/tmp` branch
    // reads no environment at all, so every fixture built through this helper walked out of
    // that sandbox and stayed. Measured 2026-09-11: 1,018 `history-*` directories left in
    // /private/tmp, which macOS removes only once they are EMPTY and three days old.
    const sandbox = env.test.getTmpRoot();

    if (sandbox) {
        return sandbox;
    }

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

const SAFE_PATH_SEGMENT = /^[^/\\\0]+$/;

/**
 * Throws if `value` isn't safe to use as a single path segment (e.g. joined into a
 * directory name) — rejects `.`, `..`, empty strings, separators, and NUL bytes.
 * Guards against path traversal from untrusted input (CLI args, API responses, etc.)
 * that gets concatenated into a filesystem path.
 */
export function assertSafePathSegment(value: string, label: string): void {
    if (value === "." || value === ".." || !SAFE_PATH_SEGMENT.test(value)) {
        throw new Error(`unsafe ${label}: ${SafeJSON.stringify(value)}`);
    }
}
