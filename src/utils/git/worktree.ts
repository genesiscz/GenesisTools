import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Executor } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { porcelain } from "./porcelain";

// =============================================================================
// Types
// =============================================================================

export interface WorktreeInfo {
    path: string;
    head: string;
    branch: string | null;
    isBare: boolean;
    isMain: boolean;
}

export interface WorktreeCreateOptions {
    branch: string;
    basePath?: string;
    startPoint?: string;
    prNumber?: number;
    cwd?: string;
}

export interface WorktreeResult {
    path: string;
    created: boolean;
    branch: string;
    dirty: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function git(cwd?: string): Executor {
    return new Executor({ prefix: "git", cwd: cwd ?? process.cwd() });
}

/**
 * Replace `/` with `-`, strip characters invalid in directory names,
 * collapse consecutive `-`, and trim leading/trailing `-`.
 */
export function slugifyBranch(branch: string): string {
    return branch
        .replace(/[/\s]+/g, "-")
        .replace(/[#~^:?*[\]\\{}<>|!@$%&=+;'",`]/g, "")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Build a worktree directory name: `pr<number>-<slugged-branch>`.
 */
export function formatWorktreeName(prNumber: number, branch: string): string {
    return `pr${prNumber}-${slugifyBranch(branch)}`;
}

// =============================================================================
// Detection
// =============================================================================

/**
 * `git worktree list --porcelain -z` as structured data. The NUL form keeps a
 * newline inside a worktree path intact; the parser lives in ./porcelain.ts.
 * `-z` needs git 2.30; an older git rejects the flag, the call fails, and this
 * returns an empty list, so callers see "no worktrees" rather than a crash.
 */
export async function listWorktrees(cwd?: string): Promise<WorktreeInfo[]> {
    const g = git(cwd);
    const result = await g.exec(porcelain.worktrees.args());

    if (!result.success) {
        return [];
    }

    return porcelain.worktrees.parse(result.stdout).map((w) => ({
        path: w.path,
        head: w.head,
        branch: w.branch,
        isBare: w.isBare,
        isMain: w.isMain,
    }));
}

/**
 * Check whether `cwd` is inside a git worktree (not the main repo).
 */
export async function isInWorktree(cwd?: string): Promise<boolean> {
    const g = git(cwd);
    const gitDirResult = await g.exec(["rev-parse", "--git-dir"]);
    const commonDirResult = await g.exec(["rev-parse", "--git-common-dir"]);

    if (!gitDirResult.success || !commonDirResult.success) {
        return false;
    }

    // In main repo: both resolve to the same path.
    // In worktree: --git-dir points to the worktree's .git file,
    // --git-common-dir points to the main repo's .git/worktrees/<name>.
    const effectiveCwd = cwd ?? process.cwd();
    const gitDir = resolve(effectiveCwd, gitDirResult.stdout);
    const commonDir = resolve(effectiveCwd, commonDirResult.stdout);

    return gitDir !== commonDir;
}

/**
 * Get the root of the main repository, even when called from a worktree.
 */
export async function getMainRepoRoot(cwd?: string): Promise<string> {
    const g = git(cwd);
    const commonDir = await g.exec(["rev-parse", "--git-common-dir"]);

    if (!commonDir.success) {
        throw new Error("Not in a git repository");
    }

    const absCommon = resolve(cwd ?? process.cwd(), commonDir.stdout);

    // If commonDir ends in .git, the main repo root is its parent.
    // If it ends in .git/worktrees/<name>, strip worktrees/<name> first.
    if (absCommon.endsWith(".git")) {
        return resolve(absCommon, "..");
    }

    // .git/worktrees/<name> → .git → parent
    const gitDir = absCommon.replace(/[/\\]worktrees[/\\][^/\\]+$/, "");
    return resolve(gitDir, "..");
}

/**
 * Sync version of getMainRepoRoot. Returns the MAIN checkout's root for any
 * directory inside a repository — a linked worktree, the main checkout itself,
 * or a subdirectory of either. Returns `dir` unchanged when it is not inside a
 * repository, or when git is unavailable.
 *
 * `--path-format=absolute` is what makes one query enough: without it git
 * answers relatively from the repo root and absolutely from a subdirectory,
 * and the older two-query form compared those two spellings and so reported a
 * plain subdirectory of the main checkout as a worktree.
 */
export function getMainRepoRootSync(dir?: string): string {
    const cwd = dir ?? process.cwd();

    try {
        const gitCommonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd,
            encoding: "utf-8",
            timeout: 2000,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();

        if (gitCommonDir.length > 0) {
            return resolve(gitCommonDir, "..");
        }
    } catch (err) {
        logger.debug({ err, cwd }, "getMainRepoRootSync: not a git repository");
    }

    return cwd;
}

/**
 * Find an existing worktree that has the given branch checked out.
 */
export async function findWorktreeForBranch(branch: string, cwd?: string): Promise<WorktreeInfo | null> {
    const worktrees = await listWorktrees(cwd);
    return worktrees.find((w) => w.branch === branch) ?? null;
}

/**
 * Get the current branch of a given directory (worktree or main repo).
 */
export async function getCurrentBranch(cwd?: string): Promise<string | null> {
    const g = git(cwd);
    const result = await g.exec(["rev-parse", "--abbrev-ref", "HEAD"]);

    if (!result.success || result.stdout === "HEAD") {
        return null;
    }

    return result.stdout;
}

// =============================================================================
// Path resolution
// =============================================================================

/**
 * Determine the base directory for worktrees by checking `.gitignore`.
 *
 * Heuristic:
 * 1. If `.gitignore` contains `.claude/worktrees` → use `<repoRoot>/.claude/worktrees/`
 * 2. If `.gitignore` contains `.worktrees/` → use `<repoRoot>/.worktrees/`
 * 3. Otherwise: use `.claude/worktrees/` and append the pattern to `.gitignore`
 */
export async function resolveWorktreeBasePath(repoRoot: string): Promise<string> {
    const gitignorePath = join(repoRoot, ".gitignore");

    let gitignoreContent = "";
    try {
        const file = Bun.file(gitignorePath);
        if (await file.exists()) {
            gitignoreContent = await file.text();
        }
    } catch {
        // No .gitignore — that's fine
    }

    const lines = gitignoreContent.split("\n").map((l) => l.trim());

    if (lines.some((l) => l.includes(".claude/worktrees"))) {
        return join(repoRoot, ".claude", "worktrees");
    }

    if (lines.some((l) => l.includes(".worktrees"))) {
        return join(repoRoot, ".worktrees");
    }

    // Default: use .claude/worktrees/ and add to .gitignore
    const basePath = join(repoRoot, ".claude", "worktrees");
    const entry = ".claude/worktrees/";

    if (!lines.includes(entry)) {
        const newContent = gitignoreContent.endsWith("\n")
            ? `${gitignoreContent}${entry}\n`
            : `${gitignoreContent}\n${entry}\n`;
        await Bun.write(gitignorePath, newContent);
    }

    return basePath;
}

// =============================================================================
// Creation
// =============================================================================

/**
 * Check if a worktree directory has uncommitted changes.
 */
async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
    const g = git(worktreePath);
    const result = await g.exec(["status", "--porcelain"]);
    return result.success && result.stdout.trim().length > 0;
}

/**
 * Ensure a worktree exists for the given branch.
 *
 * 1. If the current directory is already a worktree on that branch → return it.
 * 2. If another worktree has that branch → return its path.
 * 3. Otherwise create a new worktree.
 */
export async function ensureWorktreeForBranch(options: WorktreeCreateOptions): Promise<WorktreeResult> {
    const { branch, prNumber, cwd } = options;
    const effectiveCwd = cwd ?? process.cwd();

    // 1. Check current directory's branch
    const currentBranch = await getCurrentBranch(effectiveCwd);

    if (currentBranch === branch) {
        return {
            path: effectiveCwd,
            created: false,
            branch,
            dirty: await isWorktreeDirty(effectiveCwd),
        };
    }

    // 2. Search existing worktrees
    const existing = await findWorktreeForBranch(branch, effectiveCwd);

    if (existing && existsSync(existing.path)) {
        return {
            path: existing.path,
            created: false,
            branch,
            dirty: await isWorktreeDirty(existing.path),
        };
    }

    // 3. Create new worktree
    const mainRoot = await getMainRepoRoot(effectiveCwd);
    const rawBasePath = options.basePath ?? (await resolveWorktreeBasePath(mainRoot));
    const basePath = resolve(effectiveCwd, rawBasePath);
    const g = git(mainRoot);

    mkdirSync(basePath, { recursive: true });

    // Build worktree directory name
    const dirName = prNumber ? formatWorktreeName(prNumber, branch) : slugifyBranch(branch);
    const worktreePath = join(basePath, dirName);

    if (existsSync(worktreePath)) {
        // Directory exists but isn't a worktree for this branch — could be leftover
        // Check if it's a valid worktree
        const wBranch = await getCurrentBranch(worktreePath);

        if (wBranch === branch) {
            return {
                path: worktreePath,
                created: false,
                branch,
                dirty: await isWorktreeDirty(worktreePath),
            };
        }

        // Exists but wrong branch — error out
        throw new Error(
            `Directory ${worktreePath} already exists but is on branch '${wBranch ?? "detached"}', not '${branch}'`
        );
    }

    // Determine start point: prefer the branch if it exists locally/remotely
    let startPoint = options.startPoint ?? branch;

    // Check if branch exists locally
    const localExists = await g.exec(["rev-parse", "--verify", `refs/heads/${branch}`]);

    if (!localExists.success && !options.startPoint) {
        // Try to fetch from origin (only when no explicit startPoint was given)
        const fetchResult = await g.exec(["fetch", "origin", branch]);

        if (fetchResult.success) {
            startPoint = `origin/${branch}`;
        } else {
            throw new Error(`Branch '${branch}' not found locally or on origin`);
        }
    }

    // Create the worktree
    const createResult = await g.exec(["worktree", "add", worktreePath, startPoint]);

    if (!createResult.success) {
        throw new Error(`Failed to create worktree: ${createResult.stderr}`);
    }

    return {
        path: worktreePath,
        created: true,
        branch,
        dirty: false,
    };
}

// =============================================================================
// CLI integration
// =============================================================================

export interface HandleWorktreeOptions {
    worktree: boolean | string;
    branch: string;
    prNumber: number;
}

/**
 * Shared worktree handler for CLI commands (review, pr).
 * Ensures a worktree exists, logs status, and outputs WORKTREE_PATH.
 */
export async function handleWorktreeOption(options: HandleWorktreeOptions): Promise<void> {
    try {
        const result = await ensureWorktreeForBranch({
            branch: options.branch,
            basePath: typeof options.worktree === "string" ? options.worktree : undefined,
            prNumber: options.prNumber,
        });

        if (result.created) {
            out.error(pc.yellow(`⚠️  Created worktree: ${result.path}`));
        }

        if (result.dirty) {
            out.error(pc.yellow(`⚠️  Worktree has uncommitted changes`));
        }

        if (result.path !== process.cwd()) {
            out.error(pc.yellow(`⚠️  IMPORTANT: \`cd ${result.path}\` to work in the worktree.`));
        }

        out.println(`WORKTREE_PATH: ${result.path}`);
    } catch (err) {
        out.error(pc.red(`Worktree error: ${err instanceof Error ? err.message : String(err)}`));
        throw err;
    }
}
