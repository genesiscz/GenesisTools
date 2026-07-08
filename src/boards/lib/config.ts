import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@app/utils/json";

export interface BoardsSetConfig {
    project: string;
    branch: string;
    key: string;
    kind: string;
    title?: string;
    source?: string;
}

export const CONFIG_FILE = ".boards.json";
export const DEFAULT_ROOT = ".screenshots";

export function captureRoot(cwd: string, dirFlag?: string): string {
    return dirFlag ?? join(cwd, DEFAULT_ROOT);
}

export async function readSetConfig(root: string): Promise<BoardsSetConfig | null> {
    const path = join(root, CONFIG_FILE);
    if (!existsSync(path)) {
        return null;
    }

    try {
        return SafeJSON.parse(await readFile(path, "utf8")) as BoardsSetConfig;
    } catch {
        return null;
    }
}

export async function writeSetConfig(root: string, cfg: BoardsSetConfig): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, CONFIG_FILE), SafeJSON.stringify(cfg, null, 2));
}

function gitOutput(cwd: string, args: string[]): string | null {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf-8",
            timeout: 2000,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch {
        return null;
    }
}

/** Basename of the git main worktree root, so agents in different worktrees of the
 *  same repo share one project. Falls back to the cwd's basename outside a git repo. */
export function defaultProject(cwd: string): string {
    const commonDir = gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (commonDir) {
        return basename(dirname(commonDir));
    }

    return basename(cwd);
}

export function currentBranch(cwd: string): string {
    return gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "main";
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

export function mintKey(now: Date = new Date()): string {
    const stamp =
        `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
        `-${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
    return `s-${stamp}`;
}

/**
 * Mirrors `slugifyBranch` in `@app/dev-dashboard/lib/boards/sets-store.ts` exactly — the
 * server matches `branch_slug` by strict equality (no server-side normalization on read),
 * so the CLI must compute the identical slug for the value to resolve.
 */
export function slugifyBranch(raw: string): string {
    return (
        raw
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 64) || "main"
    );
}

/** Appends `<rootRelative>/` to `.git/info/exclude` (never `.gitignore`) so captured
 *  screenshots stay untracked without dirtying the repo. No-op outside a git repo. */
export async function ensureGitExclude(cwd: string, rootRelative: string): Promise<void> {
    const commonDir = gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!commonDir) {
        return;
    }

    const excludePath = join(commonDir, "info", "exclude");
    const entry = `${rootRelative}/`;

    let content = "";
    try {
        content = await readFile(excludePath, "utf8");
    } catch {
        content = "";
    }

    if (content.split("\n").some((line) => line.trim() === entry)) {
        return;
    }

    await mkdir(dirname(excludePath), { recursive: true });
    const next = content.length > 0 && !content.endsWith("\n") ? `${content}\n${entry}\n` : `${content}${entry}\n`;
    await writeFile(excludePath, next);
}
