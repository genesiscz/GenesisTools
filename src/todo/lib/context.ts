import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import type { GitContext, TodoContext } from "./types";

export function findProjectRoot(from: string): string | null {
    let dir = resolve(from);

    while (true) {
        if (existsSync(resolve(dir, ".git"))) {
            return dir;
        }

        const parent = dirname(dir);

        if (parent === dir) {
            return null;
        }

        dir = parent;
    }
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
