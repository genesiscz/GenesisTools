import type { ExecResult } from "@genesiscz/utils/cli";
import { Executor } from "@genesiscz/utils/cli";
import {
    type AheadBehind,
    type CherryEntry,
    type CommitInfo,
    type DiffRangeArgs,
    type LogArgs,
    type LsTreeArgs,
    type MergeTreeResult,
    type NameStatusEntry,
    type NumstatEntry,
    parseLeftRightCount,
    porcelain,
    type RawChange,
    type RawChangesArgs,
    type RefInfo,
    type StatusArgs,
    type StatusSummary,
    type TreeEntry,
    type WorktreeEntry,
} from "./porcelain";
import type { BranchInfo, DetailedCommitInfo } from "./types";

export interface GitOptions {
    cwd?: string;
    verbose?: boolean;
    debug?: boolean;
}

export class BaseNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BaseNotFoundError";
    }
}

export function createGit(options?: GitOptions) {
    const executor = new Executor({
        prefix: "git",
        cwd: options?.cwd,
        verbose: options?.verbose ?? false,
        debug: options?.debug ?? false,
        label: "git",
    });

    return {
        /** Access the underlying executor for advanced usage */
        executor,

        /** Set verbose mode */
        setVerbose(enabled: boolean) {
            executor.verbose = enabled;
        },

        /**
         * Get current working directory's git root
         */
        async getRepoRoot(): Promise<string> {
            const result = await executor.execOrThrow(["rev-parse", "--show-toplevel"], "Not in a git repository");
            return result.stdout;
        },

        /**
         * Get current branch name
         */
        async getCurrentBranch(): Promise<string> {
            const result = await executor.execOrThrow(
                ["rev-parse", "--abbrev-ref", "HEAD"],
                "Failed to get current branch"
            );
            return result.stdout;
        },

        /**
         * Get all local branches
         */
        async getBranches(): Promise<BranchInfo[]> {
            const result = await executor.execOrThrow(
                ["for-each-ref", "--format=%(refname:short)|%(objectname)|%(HEAD)", "refs/heads/"],
                "Failed to get branches"
            );

            const branches: BranchInfo[] = [];
            for (const line of result.stdout.split("\n").filter((l) => l.trim())) {
                const [name, sha, head] = line.split("|");
                branches.push({
                    name,
                    sha,
                    isCurrent: head === "*",
                });
            }
            return branches;
        },

        /**
         * Get SHA of a branch or ref
         */
        async getSha(ref: string): Promise<string> {
            const result = await executor.execOrThrow(["rev-parse", ref], `Failed to get SHA for ${ref}`);
            return result.stdout;
        },

        /**
         * Get short SHA
         */
        async getShortSha(ref: string): Promise<string> {
            const result = await executor.execOrThrow(
                ["rev-parse", "--short", ref],
                `Failed to get short SHA for ${ref}`
            );
            return result.stdout;
        },

        /**
         * Check if a branch exists
         */
        async branchExists(branch: string): Promise<boolean> {
            const result = await executor.exec(["rev-parse", "--verify", `refs/heads/${branch}`]);
            return result.success;
        },

        /**
         * Check if a ref exists
         */
        async refExists(ref: string): Promise<boolean> {
            const result = await executor.exec(["rev-parse", "--verify", ref]);
            return result.success;
        },

        /**
         * Checkout a branch
         */
        async checkout(branch: string): Promise<void> {
            await executor.execOrThrow(["checkout", branch], `Failed to checkout ${branch}`);
        },

        /**
         * Rebase current branch onto target
         */
        async rebase(target: string): Promise<ExecResult> {
            return await executor.execInteractive(["rebase", target]);
        },

        /**
         * Rebase with --onto
         * git rebase --onto <newBase> <oldBase> <branch>
         */
        async rebaseOnto(newBase: string, oldBase: string, branch?: string): Promise<ExecResult> {
            const args = ["rebase", "--onto", newBase, oldBase];
            if (branch) {
                args.push(branch);
            }
            return await executor.execInteractive(args);
        },

        /**
         * Abort a rebase in progress
         */
        async rebaseAbort(): Promise<void> {
            const result = await executor.exec(["rebase", "--abort"]);
            if (!result.success) {
                if (!result.stderr.includes("No rebase in progress")) {
                    throw new Error(`Failed to abort rebase: ${result.stderr}`);
                }
            }
        },

        /**
         * Continue a rebase
         */
        async rebaseContinue(): Promise<ExecResult> {
            return await executor.execInteractive(["rebase", "--continue"]);
        },

        /**
         * Find merge-base between two refs
         */
        async mergeBase(ref1: string, ref2: string): Promise<string> {
            const result = await executor.execOrThrow(
                ["merge-base", ref1, ref2],
                `Failed to find merge-base for ${ref1} and ${ref2}`
            );
            return result.stdout;
        },

        /**
         * Count commits between two refs
         */
        async countCommits(from: string, to: string): Promise<number> {
            const result = await executor.exec(["rev-list", "--count", `${from}..${to}`]);
            if (!result.success) {
                return 0;
            }
            return parseInt(result.stdout, 10) || 0;
        },

        /**
         * Check if working directory has uncommitted changes
         */
        async hasUncommittedChanges(): Promise<boolean> {
            const result = await executor.exec(["status", "--porcelain"]);
            return result.stdout.trim().length > 0;
        },

        /**
         * Check if a rebase is in progress
         */
        async isRebaseInProgress(): Promise<boolean> {
            const repoRoot = await this.getRepoRoot();
            const rebaseMerge = Bun.file(`${repoRoot}/.git/rebase-merge`);
            const rebaseApply = Bun.file(`${repoRoot}/.git/rebase-apply`);
            return (await rebaseMerge.exists()) || (await rebaseApply.exists());
        },

        /**
         * Check if git repository is locked (.git/index.lock exists)
         */
        async isGitLocked(): Promise<boolean> {
            const repoRoot = await this.getRepoRoot();
            const lockFile = Bun.file(`${repoRoot}/.git/index.lock`);
            return await lockFile.exists();
        },

        /**
         * Diagnose why a rebase failed by checking repository state
         */
        async diagnoseRebaseFailure(): Promise<"conflict" | "lock" | "dirty" | "unknown"> {
            if (await this.isGitLocked()) {
                return "lock";
            }

            const rebaseInProgress = await this.isRebaseInProgress();
            const hasChanges = await this.hasUncommittedChanges();

            if (rebaseInProgress && hasChanges) {
                return "conflict";
            }
            if (rebaseInProgress) {
                return "conflict";
            }
            if (hasChanges) {
                return "dirty";
            }

            return "unknown";
        },

        /**
         * Update a reference
         */
        async updateRef(ref: string, sha: string): Promise<void> {
            await executor.execOrThrow(["update-ref", ref, sha], `Failed to update ref ${ref}`);
        },

        /**
         * Delete a reference
         */
        async deleteRef(ref: string): Promise<void> {
            const result = await executor.exec(["update-ref", "-d", ref]);
            if (!result.success) {
                if (!result.stderr.includes("not a valid ref")) {
                    throw new Error(`Failed to delete ref ${ref}: ${result.stderr}`);
                }
            }
        },

        /**
         * Create a lightweight tag
         */
        async createTag(name: string, sha: string): Promise<void> {
            await executor.execOrThrow(["tag", name, sha], `Failed to create tag ${name}`);
        },

        /**
         * Delete a tag
         */
        async deleteTag(name: string): Promise<void> {
            await executor.exec(["tag", "-d", name]);
            // Ignore errors - tag might not exist
        },

        /**
         * List all refs matching a pattern
         */
        async listRefs(pattern: string): Promise<string[]> {
            const result = await executor.exec(["for-each-ref", "--format=%(refname)", pattern]);
            if (!result.success) {
                return [];
            }
            return result.stdout.split("\n").filter((l) => l.trim());
        },

        /**
         * Reset current branch to a specific commit
         */
        async resetHard(sha: string): Promise<void> {
            await executor.execOrThrow(["reset", "--hard", sha], `Failed to reset to ${sha}`);
        },

        /**
         * Stash current working tree changes
         */
        async stash(message?: string): Promise<void> {
            const args = ["stash", "push"];
            if (message) {
                args.push("-m", message);
            }
            await executor.execOrThrow(args, "Failed to stash");
        },

        /**
         * Pull from remote tracking branch
         */
        async pull(branch: string): Promise<void> {
            await this.checkout(branch);
            const result = await executor.execInteractive(["pull"]);
            if (!result.success) {
                throw new Error(`Failed to pull ${branch}`);
            }
        },

        /**
         * Get the remote tracking branch for a local branch
         * Returns null if no tracking branch configured
         */
        async getTrackingBranch(branch: string): Promise<string | null> {
            const result = await executor.exec(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
            return result.success ? result.stdout : null;
        },

        /**
         * Get divergence info between local and remote
         */
        async getDivergence(
            local: string,
            remote: string
        ): Promise<{
            localOnly: number;
            remoteOnly: number;
            localCommits: string[];
            remoteCommits: string[];
        }> {
            const localOnly = await this.countCommits(remote, local);
            const remoteOnly = await this.countCommits(local, remote);

            const localCommits =
                localOnly > 0
                    ? (await executor.exec(["log", "--oneline", `${remote}..${local}`, "-5"])).stdout
                          .split("\n")
                          .filter(Boolean)
                    : [];
            const remoteCommits =
                remoteOnly > 0
                    ? (await executor.exec(["log", "--oneline", `${local}..${remote}`, "-5"])).stdout
                          .split("\n")
                          .filter(Boolean)
                    : [];

            return { localOnly, remoteOnly, localCommits, remoteCommits };
        },

        /**
         * Get list of commits between two refs
         */
        async getCommitsBetween(from: string, to: string, limit = 10): Promise<string[]> {
            const result = await executor.exec(["log", "--oneline", `${from}..${to}`, `-${limit}`]);
            return result.success ? result.stdout.split("\n").filter(Boolean) : [];
        },

        /**
         * Get branches that contain a specific commit
         */
        async branchesContaining(sha: string): Promise<string[]> {
            const result = await executor.exec(["branch", "--contains", sha, "--format=%(refname:short)"]);
            if (!result.success) {
                return [];
            }
            return result.stdout.split("\n").filter((l) => l.trim());
        },

        /**
         * Check if commit A is ancestor of commit B
         */
        async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
            const result = await executor.exec(["merge-base", "--is-ancestor", ancestor, descendant]);
            return result.success;
        },

        // === NEW methods ===

        /**
         * Cherry-pick a single commit
         */
        async cherryPick(sha: string): Promise<ExecResult> {
            return await executor.exec(["cherry-pick", sha]);
        },

        /**
         * Abort a cherry-pick in progress
         */
        async cherryPickAbort(): Promise<void> {
            await executor.exec(["cherry-pick", "--abort"]);
        },

        /**
         * Create a new branch at a given start point
         */
        async createBranch(name: string, startPoint?: string): Promise<void> {
            const args = ["checkout", "-b", name];
            if (startPoint) {
                args.push(startPoint);
            }
            await executor.execOrThrow(args, `Failed to create branch ${name}`);
        },

        /**
         * Get detailed commit info between two refs (oldest first)
         */
        async getDetailedCommits(from: string, to: string): Promise<DetailedCommitInfo[]> {
            const result = await executor.exec([
                "log",
                "--reverse",
                "--pretty=format:%H%x00%h%x00%an%x00%ai%x00%s",
                `${from}..${to}`,
            ]);
            if (!result.success || !result.stdout.trim()) {
                return [];
            }
            return result.stdout
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                    const [hash, shortHash, author, date, ...rest] = line.split("\0");
                    return { hash, shortHash, author, date, message: rest.join("\0") };
                });
        },

        /**
         * List local branch short-names via `for-each-ref refs/heads`.
         */
        async listLocalBranchNames(): Promise<string[]> {
            const { stdout } = await executor.exec(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
            return stdout
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
        },

        /**
         * Set of branch names whose upstream tracking branch is gone (`[gone]`).
         */
        async upstreamGoneBranches(): Promise<Set<string>> {
            const { stdout } = await executor.exec([
                "for-each-ref",
                "--format=%(refname:short)\t%(upstream:track)",
                "refs/heads",
            ]);

            const gone = new Set<string>();
            for (const line of stdout.split("\n")) {
                const [name, track] = line.split("\t");
                if (name && track?.includes("gone")) {
                    gone.add(name.trim());
                }
            }

            return gone;
        },

        /**
         * Committer epoch (seconds) of a branch tip via `log -1 --format=%ct`.
         */
        async lastCommitEpoch(branch: string): Promise<number> {
            const { stdout, success } = await executor.exec(["log", "-1", "--format=%ct", branch]);
            if (!success) {
                return 0;
            }

            const epoch = Number.parseInt(stdout, 10);
            return Number.isNaN(epoch) ? 0 : epoch;
        },

        /**
         * Ahead/behind vs base via `rev-list --left-right --count base...branch`
         * (left=behind, right=ahead).
         */
        async aheadBehind(base: string, branch: string): Promise<AheadBehind> {
            const { stdout, success } = await executor.exec([
                "rev-list",
                "--left-right",
                "--count",
                `${base}...${branch}`,
            ]);
            return success ? parseLeftRightCount(stdout) : { ahead: 0, behind: 0 };
        },

        // === Typed porcelain readers (parsers in ./porcelain.ts) ===

        /**
         * `git status --porcelain=v2 -z --branch`, typed. Untracked files are
         * listed individually. Runs with `GIT_OPTIONAL_LOCKS=0`, so a status
         * never takes the index lock or rewrites the index as a side effect.
         */
        async status(opts: StatusArgs & { cwd?: string } = {}): Promise<StatusSummary> {
            const res = await executor.exec(porcelain.status.args(opts), {
                cwd: opts.cwd,
                env: { GIT_OPTIONAL_LOCKS: "0" },
            });

            if (!res.success) {
                throw new Error(`git status failed: ${res.stderr}`);
            }

            return porcelain.status.parse(res.stdout);
        },

        /**
         * `git for-each-ref` over the given patterns (default: local heads),
         * typed with upstream tracking. `LC_ALL=C` keeps the `[ahead N]`,
         * `[behind N]` and `[gone]` markers in the form the parser reads.
         */
        async refs(patterns?: string[]): Promise<RefInfo[]> {
            const res = await executor.exec(porcelain.refs.args(patterns), { env: { LC_ALL: "C" } });

            if (!res.success) {
                throw new Error(`git for-each-ref failed: ${res.stderr}`);
            }

            return porcelain.refs.parse(res.stdout);
        },

        /** `git log -z` over a range, typed; `paths` limits it, `limit` caps the count. */
        async log(opts: LogArgs): Promise<CommitInfo[]> {
            const res = await executor.execOrThrow(porcelain.log.args(opts), `git log ${opts.range} failed`);
            return porcelain.log.parse(res.stdout);
        },

        /** `git diff --name-status -z` between two trees; renames are only detected when asked. */
        async nameStatus(opts: DiffRangeArgs): Promise<NameStatusEntry[]> {
            const res = await executor.execOrThrow(
                porcelain.nameStatus.args(opts),
                `git diff --name-status ${opts.from} ${opts.to} failed`
            );
            return porcelain.nameStatus.parse(res.stdout);
        },

        /** `git ls-tree -r -z --full-tree <ref>`, typed. */
        async lsTree(opts: LsTreeArgs): Promise<TreeEntry[]> {
            const res = await executor.execOrThrow(porcelain.lsTree.args(opts), `git ls-tree ${opts.ref} failed`);
            return porcelain.lsTree.parse(res.stdout);
        },

        /** `git log --raw -z --no-abbrev` over a range: every blob every commit gave every path. */
        async rawChanges(opts: RawChangesArgs): Promise<RawChange[]> {
            const res = await executor.execOrThrow(
                porcelain.rawChanges.args(opts),
                `git log --raw ${opts.range} failed`
            );
            return porcelain.rawChanges.parse(res.stdout);
        },

        /** `git diff --numstat -z` between two trees, typed; binary files carry `binary: true`. */
        async numstat(opts: DiffRangeArgs): Promise<NumstatEntry[]> {
            const res = await executor.execOrThrow(
                porcelain.numstat.args(opts),
                `git diff --numstat ${opts.from} ${opts.to} failed`
            );
            return porcelain.numstat.parse(res.stdout);
        },

        /** `git cherry -v <upstream> <head>`: which of head's commits have an equivalent patch upstream. */
        async cherry(upstream: string, head: string): Promise<CherryEntry[]> {
            const res = await executor.execOrThrow(
                porcelain.cherry.args(upstream, head),
                `git cherry ${upstream} ${head} failed`
            );
            return porcelain.cherry.parse(res.stdout);
        },

        /**
         * `git merge-tree --write-tree`: the merge result without touching the
         * index or the worktree. Exit 1 means conflicts, anything above 1 is
         * an error (an old git without `--write-tree` lands here).
         */
        async mergeTree(base: string, branch: string): Promise<MergeTreeResult> {
            const res = await executor.exec(porcelain.mergeTree.args(base, branch), { env: { LC_ALL: "C" } });

            if (res.exitCode > 1) {
                throw new Error(`git merge-tree ${base} ${branch} failed: ${res.stderr}`);
            }

            return porcelain.mergeTree.parse(res.stdout, res.exitCode);
        },

        /** `git worktree list --porcelain -z`, typed, including locked/prunable reasons; paths keep any newline. */
        async worktrees(): Promise<WorktreeEntry[]> {
            const res = await executor.execOrThrow(porcelain.worktrees.args(), "git worktree list failed");
            return porcelain.worktrees.parse(res.stdout);
        },

        /**
         * Absolute paths of the repo root and the git common dir (shared by every worktree).
         * `--path-format=absolute` needs git 2.31; an older git fails the whole call rather
         * than returning a relative path, so the error names the requirement.
         */
        async layout(): Promise<{ repoRoot: string; commonDir: string }> {
            const res = await executor.execOrThrow(
                ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
                "Not in a git repository (or git is older than 2.31, which lacks --path-format)"
            );
            const [repoRoot, commonDir] = res.stdout.split("\n").map((l) => l.trim());
            return { repoRoot, commonDir };
        },
    };
}

/** Convenience: a default verbose git instance bound to the process cwd. */
export const git = createGit({ verbose: true });
