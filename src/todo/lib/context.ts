import { hostname } from "node:os";
import { whoIsCallingHere } from "@genesiscz/utils/agent/caller-identity";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { createGit, detectOrigin, type StatusSummary } from "@genesiscz/utils/git";
import { logger } from "@genesiscz/utils/logger";
import type { GitContext, TodoContext } from "./types";

export { findProjectRoot };

/**
 * The session a todo belongs to.
 *
 * Callers used to have to interpolate `$CLAUDE_CODE_SESSION_ID` themselves, which
 * expands to nothing under grok or codex. `current` (or an omitted flag, where
 * the command defaults it) asks the host instead.
 */
export function resolveSessionOption(value: string | undefined): string | undefined {
    if (value && value !== "current") {
        return value;
    }

    if (value === undefined) {
        return undefined;
    }

    const sessionId = whoIsCallingHere().sessionId;
    if (!sessionId) {
        // Returning undefined here would drop the filter and list every todo in
        // the project — the opposite of what `--session current` asked for.
        throw new Error("No current agent session to resolve. Pass an explicit session id instead of 'current'.");
    }

    return sessionId;
}

/** The session id to stamp on new records: the explicit flag, else the host's. */
export function defaultSessionId(value: string | undefined): string | undefined {
    return resolveSessionOption(value) ?? whoIsCallingHere().sessionId ?? undefined;
}

async function captureGitContext(cwd: string): Promise<GitContext | undefined> {
    const git = createGit({ cwd });
    let summary: StatusSummary;

    try {
        summary = await git.status();
    } catch (err) {
        logger.debug({ err, cwd }, "todo context: no git status here, so the todo records no git context");
        return undefined;
    }

    const { branch } = summary;

    if (!branch) {
        return undefined;
    }

    const [commits, origin] = await Promise.all([
        git.log({ range: "HEAD", limit: 1 }).catch((err: unknown) => {
            logger.debug({ err, cwd }, "todo context: no commit to read (a branch with no commits yet)");
            return [];
        }),
        detectOrigin(cwd, git.executor),
    ]);

    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const entry of summary.entries) {
        if (entry.kind === "untracked") {
            untracked.push(entry.path);
        } else if (entry.kind !== "ignored") {
            if (entry.index !== ".") {
                staged.push(entry.path);
            }

            if (entry.worktree !== ".") {
                unstaged.push(entry.path);
            }
        }
    }

    return {
        branch: branch.head === "(detached)" ? "HEAD" : branch.head,
        commitSha: branch.oid === "(initial)" ? "" : branch.oid,
        commitMessage: commits[0]?.subject ?? "",
        stagedFiles: staged,
        unstagedFiles: unstaged,
        untrackedFiles: untracked,
        remote: origin?.url,
    };
}

export async function captureContext(options?: { projectRoot?: string }): Promise<TodoContext> {
    const projectRoot = options?.projectRoot ?? findProjectRoot(process.cwd()) ?? process.cwd();

    const now = new Date().toISOString();
    const gitContext = await captureGitContext(projectRoot);

    return {
        git: gitContext,
        cwd: process.cwd(),
        projectRoot,
        hostname: hostname(),
        createdAt: now,
        updatedAt: now,
    };
}
