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
    if (!encodedProjectDirectories(options.providerId) || !options.projectDirectory) {
        return false;
    }
    return options.requested.startsWith("-")
        ? options.projectDirectory.startsWith(`${options.requested}-`)
        : options.projectDirectory.includes(options.requested);
}

/**
 * `historyProjectMatches` as a SQL condition on `m.project` and `m.project_directory`, for a query over one
 * provider's rows. Keep the two in step: `service.test.ts` checks the catalog counts this serves against the catalog.
 * SQLite's `substr`, `length` and `instr` count characters, so they answer what `startsWith` and `includes` answer.
 */
export function historyProjectSql(options: { providerId: string; requested: string }): {
    sql: string;
    params: string[];
} {
    const exact = "m.project = ? OR m.project_directory = ?";
    const params = [options.requested, options.requested];

    if (!encodedProjectDirectories(options.providerId)) {
        return { sql: `(${exact})`, params };
    }

    if (options.requested.startsWith("-")) {
        const prefix = `${options.requested}-`;
        return {
            sql: `(${exact} OR (m.project_directory <> '' AND substr(m.project_directory, 1, length(?)) = ?))`,
            params: [...params, prefix, prefix],
        };
    }

    return {
        sql: `(${exact} OR (m.project_directory <> '' AND instr(m.project_directory, ?) > 0))`,
        params: [...params, options.requested],
    };
}

/** Whether a provider's project directories are Claude's encoded folders, which a worktree suffix extends. */
function encodedProjectDirectories(providerId: string): boolean {
    return providerId === "anthropic-sub";
}
