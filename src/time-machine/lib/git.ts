import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";

export interface CommitInfo {
    sha: string;
    shortSha: string;
    author: string;
    authorEmail: string;
    date: string;
    subject: string;
}

export interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * Field-separated `git log` so we can parse commit metadata without choking on
 * subjects that contain newlines or our separators. `%x1f` is the ASCII unit
 * separator (0x1F) between fields, `%x1e` the record separator (0x1E) between
 * commits — neither appears in normal commit text.
 */
const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";

async function runGit(args: string[], cwd: string): Promise<RunResult> {
    const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { exitCode, stdout, stderr };
}

export async function isGitRepo(cwd: string): Promise<boolean> {
    const result = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
    return result.exitCode === 0 && result.stdout.trim() === "true";
}

/**
 * Resolve a ref (branch / tag / sha / HEAD~N) to a full commit sha. Returns
 * null when the ref cannot be resolved.
 */
export async function resolveRef(ref: string, cwd: string): Promise<string | null> {
    const result = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    if (result.exitCode !== 0) {
        return null;
    }

    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
}

function parseLog(stdout: string): CommitInfo[] {
    const commits: CommitInfo[] = [];

    for (const record of stdout.split("\x1e")) {
        const trimmed = record.replace(/^\n+/, "");
        if (trimmed.length === 0) {
            continue;
        }

        const [sha, shortSha, author, authorEmail, date, subject] = trimmed.split("\x1f");
        if (!sha) {
            continue;
        }

        commits.push({
            sha,
            shortSha: shortSha ?? sha.slice(0, 7),
            author: author ?? "",
            authorEmail: authorEmail ?? "",
            date: date ?? "",
            subject: subject ?? "",
        });
    }

    return commits;
}

/**
 * List commits reachable from `startRef` (default HEAD), newest first, capped
 * at `depth`. When `goodRef` is provided, the range is limited to
 * `good..start` so commits at or before the known-good lower bound are
 * excluded.
 *
 * Returned order is newest → oldest (git's native order).
 */
export async function listCommits(opts: {
    cwd: string;
    startRef: string;
    depth: number;
    goodRef?: string | null;
}): Promise<CommitInfo[]> {
    const { cwd, startRef, depth, goodRef } = opts;
    const range = goodRef ? `${goodRef}..${startRef}` : startRef;
    const args = ["log", `--max-count=${depth}`, `--format=${LOG_FORMAT}`, range];
    const result = await runGit(args, cwd);

    if (result.exitCode !== 0) {
        throw new Error(`git log failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }

    return parseLog(result.stdout);
}

export async function getCommitInfo(sha: string, cwd: string): Promise<CommitInfo | null> {
    const result = await runGit(["show", "--no-patch", `--format=${LOG_FORMAT}`, sha], cwd);
    if (result.exitCode !== 0) {
        return null;
    }

    const commits = parseLog(result.stdout);
    return commits[0] ?? null;
}

/**
 * `git show <sha>` (full patch). Caller decides how much to print.
 */
export async function getCommitDiff(sha: string, cwd: string): Promise<string> {
    const result = await runGit(["show", "--no-color", sha], cwd);
    if (result.exitCode !== 0) {
        throw new Error(`git show ${sha} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }

    return result.stdout;
}

/**
 * Create a throwaway worktree under the OS temp dir checked out at `sha`. The
 * USER'S working tree and branch are never touched. The returned `cleanup`
 * removes the worktree registration and deletes the temp directory.
 *
 * `--detach` so we never create or move a branch; the worktree is a detached
 * HEAD at the given commit.
 */
export async function createTempWorktree(opts: {
    repoCwd: string;
    sha: string;
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const { repoCwd, sha } = opts;
    const base = await mkdtemp(join(tmpdir(), "time-machine-"));
    const worktreePath = join(base, "wt");

    const add = await runGit(["worktree", "add", "--detach", "--quiet", worktreePath, sha], repoCwd);
    if (add.exitCode !== 0) {
        await rm(base, { recursive: true, force: true });
        throw new Error(`git worktree add failed: ${add.stderr.trim() || `exit ${add.exitCode}`}`);
    }

    const cleanup = async (): Promise<void> => {
        // Best-effort, independent steps: a failure removing the registration
        // must not prevent deleting the temp dir, and vice-versa. `runGit`
        // resolves a RunResult instead of throwing, so inspect the exit code.
        const remove = await runGit(["worktree", "remove", "--force", worktreePath], repoCwd);
        if (remove.exitCode !== 0) {
            logger.debug(
                { worktreePath, exitCode: remove.exitCode, stderr: remove.stderr },
                "time-machine: worktree remove failed during cleanup"
            );
        }

        try {
            await rm(base, { recursive: true, force: true });
        } catch (err) {
            logger.debug({ err, base }, "time-machine: temp dir removal failed during cleanup");
        }
    };

    return { path: worktreePath, cleanup };
}

/**
 * Check out `sha` (detached) inside an EXISTING worktree, reusing it across
 * probes so we pay the `worktree add` cost only once.
 */
export async function checkoutInWorktree(sha: string, worktreePath: string): Promise<void> {
    // `-f` so a probe that dirtied tracked files doesn't wedge the next
    // checkout. The worktree is throwaway, so discarding its state is safe.
    const result = await runGit(["checkout", "--detach", "--force", "--quiet", sha], worktreePath);
    if (result.exitCode !== 0) {
        throw new Error(`git checkout ${sha} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }

    // Remove untracked files/dirs (incl. gitignored build output such as
    // node_modules / coverage) left behind by the previous probe so each probe
    // sees a pristine tree. The verdict is the command's exit code, so stray
    // artifacts could otherwise flip it.
    const clean = await runGit(["clean", "-fdx"], worktreePath);
    if (clean.exitCode !== 0) {
        throw new Error(`git clean failed: ${clean.stderr.trim() || `exit ${clean.exitCode}`}`);
    }
}

/**
 * Run an arbitrary command (argv form) in `cwd`. Used both to probe the
 * current working tree and to probe each checked-out commit. The exit code is
 * the verdict: 0 = pass, anything else = fail.
 */
export async function runCommandInDir(opts: {
    command: string[];
    cwd: string;
    captureOutput: boolean;
}): Promise<RunResult> {
    const { command, cwd, captureOutput } = opts;
    const proc = Bun.spawn(command, {
        cwd,
        stdout: captureOutput ? "pipe" : "inherit",
        stderr: captureOutput ? "pipe" : "inherit",
    });

    if (!captureOutput) {
        const exitCode = await proc.exited;
        return { exitCode, stdout: "", stderr: "" };
    }

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { exitCode, stdout, stderr };
}
