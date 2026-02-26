import type { ExecResult } from "@app/utils/cli";
import { Executor } from "@app/utils/cli";
import type { BranchInfo, DetailedCommitInfo } from "./types";

export interface GitOptions {
    cwd?: string;
    verbose?: boolean;
    debug?: boolean;
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

        /**
         * Find potential child branches of a parent branch
         */
        async findPotentialChildren(parentBranch: string): Promise<Array<{ name: string; commitsAhead: number }>> {
            const branches = await this.getBranches();
            const parentSha = await this.getSha(parentBranch);
            const children: Array<{ name: string; commitsAhead: number }> = [];

            for (const branch of branches) {
                if (branch.name === parentBranch) {
                    continue;
                }

                try {
                    const parentIsAncestor = await this.isAncestor(parentSha, branch.sha);
                    if (!parentIsAncestor) {
                        continue;
                    }

                    const commitsAhead = await this.countCommits(parentSha, branch.name);
                    if (commitsAhead > 0) {
                        children.push({ name: branch.name, commitsAhead });
                    }
                } catch {}
            }

            return children.sort((a, b) => a.name.localeCompare(b.name));
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
    };
}

/** Convenience: create a default git instance (verbose=true for backward compat with git-rebase-multiple) */
export const git = createGit({ verbose: true });
