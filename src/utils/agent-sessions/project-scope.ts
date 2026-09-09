import { isAbsolute, relative } from "node:path";

/**
 * Whether `path` sits at or under `root`.
 *
 * `node:path` rather than string arithmetic: `src/utils/**` is the shared cross-platform
 * package, and a hardcoded "/" makes every containment test false on Windows, which silently
 * disabled root scoping and stale pruning there.
 */
export function historyPathUnderRoot(path: string, root: string): boolean {
    const subpath = relative(root, path);

    return (
        subpath === "" ||
        (!isAbsolute(subpath) && subpath !== ".." && !subpath.startsWith("../") && !subpath.startsWith("..\\"))
    );
}

/** Claude's encoded project directories include worktree suffixes; other providers use project names. */
export function historyProjectMatches(options: {
    providerId: string;
    project?: string | null;
    projectDirectory?: string | null;
    requested: string;
}): boolean {
    if (options.project === options.requested || options.projectDirectory === options.requested) {
        return true;
    }
    if (options.providerId !== "anthropic-sub" || !options.projectDirectory) {
        return false;
    }
    return options.requested.startsWith("-")
        ? options.projectDirectory.startsWith(`${options.requested}-`)
        : options.projectDirectory.includes(options.requested);
}
