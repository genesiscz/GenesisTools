import { hostname } from "node:os";
import { resolveAgentHost } from "@genesiscz/utils/agent-host";
import { env } from "@genesiscz/utils/env";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
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

    const sessionId = resolveAgentHost(env.getProcessEnv()).sessionId;
    if (!sessionId) {
        // Returning undefined here would drop the filter and list every todo in
        // the project — the opposite of what `--session current` asked for.
        throw new Error("No current agent session to resolve. Pass an explicit session id instead of 'current'.");
    }

    return sessionId;
}

/** The session id to stamp on new records: the explicit flag, else the host's. */
export function defaultSessionId(value: string | undefined): string | undefined {
    return resolveSessionOption(value) ?? resolveAgentHost(env.getProcessEnv()).sessionId ?? undefined;
}

async function git(args: string[], cwd: string): Promise<string | null> {
    try {
        const proc = Bun.spawn(["git", ...args], {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
        });

        const output = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
            return null;
        }

        return output.trim();
    } catch {
        return null;
    }
}

async function captureGitContext(cwd: string): Promise<GitContext | undefined> {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);

    if (branch === null) {
        return undefined;
    }

    const [commitSha, commitMessage, remote, statusOutput] = await Promise.all([
        git(["rev-parse", "HEAD"], cwd),
        git(["log", "-1", "--format=%s"], cwd),
        git(["remote", "get-url", "origin"], cwd),
        git(["status", "--porcelain"], cwd),
    ]);

    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    if (statusOutput) {
        for (const line of statusOutput.split("\n")) {
            if (!line) {
                continue;
            }

            const x = line[0];
            const y = line[1];
            const file = line.slice(3);

            if (x === "?") {
                untracked.push(file);
            } else {
                if (x !== " " && x !== "?") {
                    staged.push(file);
                }

                if (y !== " " && y !== "?") {
                    unstaged.push(file);
                }
            }
        }
    }

    return {
        branch,
        commitSha: commitSha ?? "",
        commitMessage: commitMessage ?? "",
        stagedFiles: staged,
        unstagedFiles: unstaged,
        untrackedFiles: untracked,
        remote: remote ?? undefined,
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
