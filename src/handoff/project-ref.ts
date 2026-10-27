import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { gatherHarnessPoster } from "@genesiscz/utils/agent/runtime";

export interface ResolvedHandoffProject {
    /** The project name the handoff is filed under. */
    project: string;
    /** The checkout a run link opens in, when the caller named a path. A bare name has none. */
    launchCwd: string | null;
}

function looksLikePath(value: string): boolean {
    return isAbsolute(value) || value.startsWith("~") || value.startsWith(".") || /[/\\]/.test(value);
}

/**
 * The project a caller names for a handoff: a bare name is kept as given, a path is resolved by the
 * same poster stamp that names the project of a handoff, a decision or a question posted from that
 * folder (`gatherHarnessPoster`), so a subfolder names its repository and a linked worktree names
 * its main checkout. A path that is not a folder is refused, so a typo never files a handoff under
 * a project nobody has.
 */
export function resolveHandoffProject(raw: unknown, field = "project"): ResolvedHandoffProject {
    if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new Error(
            `${field} must be a project name or a repository path — e.g. "col-tools" or "/path/to/col-tools".`
        );
    }

    const value = raw.trim();

    if (!looksLikePath(value)) {
        return { project: value, launchCwd: null };
    }

    const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
    const abs = resolve(expanded);

    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        throw new Error(
            `${field} "${value}" is not a folder on this Mac — pass an existing repository path or a name.`
        );
    }

    const ctx = gatherHarnessPoster(
        { cwd: abs, sessionId: null, sessionTitle: null, branch: null, commitSha: null, commitMessage: null },
        {}
    );

    return { project: ctx.project, launchCwd: ctx.isWorktree ? (ctx.worktreePath ?? abs) : ctx.repoRoot };
}
