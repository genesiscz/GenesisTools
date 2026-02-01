import chalk from "chalk";
import type { BranchInfo, GitCommandResult } from "./types";

// Verbose mode flag - ON by default to show all git commands
let verboseMode = true;

/**
 * Enable or disable verbose command logging
 */
export function setVerbose(enabled: boolean): void {
	verboseMode = enabled;
}

/**
 * Check if verbose mode is enabled
 */
export function isVerbose(): boolean {
	return verboseMode;
}

/**
 * Execute a git command and return the result
 */
async function exec(args: string[], cwd?: string): Promise<GitCommandResult> {
	if (verboseMode) {
		console.log(chalk.gray(`  $ git ${args.join(" ")}`));
	}

	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd: cwd ?? process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return {
		success: exitCode === 0,
		stdout: stdout.trim(),
		stderr: stderr.trim(),
		exitCode,
	};
}

/**
 * Execute git command with interactive terminal (for rebase)
 */
async function execInteractive(args: string[], cwd?: string): Promise<GitCommandResult> {
	if (verboseMode) {
		console.log(chalk.cyan(`  $ git ${args.join(" ")}`));
	}

	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd: cwd ?? process.cwd(),
		stdio: ["inherit", "inherit", "inherit"],
	});

	const exitCode = await proc.exited;

	return {
		success: exitCode === 0,
		stdout: "",
		stderr: "",
		exitCode,
	};
}

/**
 * Git operations wrapper
 */
export const git = {
	/**
	 * Get current working directory's git root
	 */
	async getRepoRoot(): Promise<string> {
		const result = await exec(["rev-parse", "--show-toplevel"]);
		if (!result.success) {
			throw new Error("Not in a git repository");
		}
		return result.stdout;
	},

	/**
	 * Get current branch name
	 */
	async getCurrentBranch(): Promise<string> {
		const result = await exec(["rev-parse", "--abbrev-ref", "HEAD"]);
		if (!result.success) {
			throw new Error("Failed to get current branch");
		}
		return result.stdout;
	},

	/**
	 * Get all local branches
	 */
	async getBranches(): Promise<BranchInfo[]> {
		const result = await exec(["for-each-ref", "--format=%(refname:short)|%(objectname)|%(HEAD)", "refs/heads/"]);
		if (!result.success) {
			throw new Error("Failed to get branches");
		}

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
		const result = await exec(["rev-parse", ref]);
		if (!result.success) {
			throw new Error(`Failed to get SHA for ${ref}: ${result.stderr}`);
		}
		return result.stdout;
	},

	/**
	 * Get short SHA
	 */
	async getShortSha(ref: string): Promise<string> {
		const result = await exec(["rev-parse", "--short", ref]);
		if (!result.success) {
			throw new Error(`Failed to get short SHA for ${ref}`);
		}
		return result.stdout;
	},

	/**
	 * Check if a branch exists
	 */
	async branchExists(branch: string): Promise<boolean> {
		const result = await exec(["rev-parse", "--verify", `refs/heads/${branch}`]);
		return result.success;
	},

	/**
	 * Check if a ref exists
	 */
	async refExists(ref: string): Promise<boolean> {
		const result = await exec(["rev-parse", "--verify", ref]);
		return result.success;
	},

	/**
	 * Checkout a branch
	 */
	async checkout(branch: string): Promise<void> {
		const result = await exec(["checkout", branch]);
		if (!result.success) {
			throw new Error(`Failed to checkout ${branch}: ${result.stderr}`);
		}
	},

	/**
	 * Rebase current branch onto target
	 */
	async rebase(target: string): Promise<GitCommandResult> {
		return await execInteractive(["rebase", target]);
	},

	/**
	 * Rebase with --onto
	 * git rebase --onto <newBase> <oldBase> <branch>
	 */
	async rebaseOnto(newBase: string, oldBase: string, branch?: string): Promise<GitCommandResult> {
		const args = ["rebase", "--onto", newBase, oldBase];
		if (branch) {
			args.push(branch);
		}
		return await execInteractive(args);
	},

	/**
	 * Abort a rebase in progress
	 */
	async rebaseAbort(): Promise<void> {
		const result = await exec(["rebase", "--abort"]);
		if (!result.success) {
			// It's okay if there's no rebase to abort
			if (!result.stderr.includes("No rebase in progress")) {
				throw new Error(`Failed to abort rebase: ${result.stderr}`);
			}
		}
	},

	/**
	 * Continue a rebase
	 */
	async rebaseContinue(): Promise<GitCommandResult> {
		return await execInteractive(["rebase", "--continue"]);
	},

	/**
	 * Find merge-base between two refs
	 */
	async mergeBase(ref1: string, ref2: string): Promise<string> {
		const result = await exec(["merge-base", ref1, ref2]);
		if (!result.success) {
			throw new Error(`Failed to find merge-base for ${ref1} and ${ref2}: ${result.stderr}`);
		}
		return result.stdout;
	},

	/**
	 * Count commits between two refs
	 */
	async countCommits(from: string, to: string): Promise<number> {
		const result = await exec(["rev-list", "--count", `${from}..${to}`]);
		if (!result.success) {
			return 0;
		}
		return parseInt(result.stdout) || 0;
	},

	/**
	 * Check if working directory has uncommitted changes
	 */
	async hasUncommittedChanges(): Promise<boolean> {
		const result = await exec(["status", "--porcelain"]);
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
	 * This usually means another git process is running
	 */
	async isGitLocked(): Promise<boolean> {
		const repoRoot = await this.getRepoRoot();
		const lockFile = Bun.file(`${repoRoot}/.git/index.lock`);
		return await lockFile.exists();
	},

	/**
	 * Diagnose why a rebase failed by checking repository state
	 * Call this AFTER a rebase command returns non-zero exit code
	 */
	async diagnoseRebaseFailure(): Promise<"conflict" | "lock" | "dirty" | "unknown"> {
		// Check in order of priority
		if (await this.isGitLocked()) return "lock";

		// Check for rebase in progress BEFORE checking for dirty tree
		// When conflicts occur, both conditions are true, but "conflict" is more specific
		const rebaseInProgress = await this.isRebaseInProgress();
		const hasChanges = await this.hasUncommittedChanges();

		if (rebaseInProgress && hasChanges) {
			// Both conditions true = conflicts during rebase
			return "conflict";
		}

		if (rebaseInProgress) {
			// Rebase in progress but no changes = shouldn't happen, but treat as conflict
			return "conflict";
		}

		if (hasChanges) {
			// Changes but no rebase = user has uncommitted changes
			return "dirty";
		}

		return "unknown";
	},

	/**
	 * Update a reference
	 */
	async updateRef(ref: string, sha: string): Promise<void> {
		const result = await exec(["update-ref", ref, sha]);
		if (!result.success) {
			throw new Error(`Failed to update ref ${ref}: ${result.stderr}`);
		}
	},

	/**
	 * Delete a reference
	 */
	async deleteRef(ref: string): Promise<void> {
		const result = await exec(["update-ref", "-d", ref]);
		if (!result.success) {
			// Ignore errors if ref doesn't exist
			if (!result.stderr.includes("not a valid ref")) {
				throw new Error(`Failed to delete ref ${ref}: ${result.stderr}`);
			}
		}
	},

	/**
	 * Create a lightweight tag
	 */
	async createTag(name: string, sha: string): Promise<void> {
		const result = await exec(["tag", name, sha]);
		if (!result.success) {
			throw new Error(`Failed to create tag ${name}: ${result.stderr}`);
		}
	},

	/**
	 * Delete a tag
	 */
	async deleteTag(name: string): Promise<void> {
		await exec(["tag", "-d", name]);
		// Ignore errors - tag might not exist
	},

	/**
	 * List all refs matching a pattern
	 */
	async listRefs(pattern: string): Promise<string[]> {
		const result = await exec(["for-each-ref", "--format=%(refname)", pattern]);
		if (!result.success) {
			return [];
		}
		return result.stdout.split("\n").filter((l) => l.trim());
	},

	/**
	 * Reset current branch to a specific commit
	 */
	async resetHard(sha: string): Promise<void> {
		const result = await exec(["reset", "--hard", sha]);
		if (!result.success) {
			throw new Error(`Failed to reset to ${sha}: ${result.stderr}`);
		}
	},

	/**
	 * Stash current working tree changes
	 */
	async stash(message?: string): Promise<void> {
		const args = ["stash", "push"];
		if (message) args.push("-m", message);
		const result = await exec(args);
		if (!result.success) {
			throw new Error(`Failed to stash: ${result.stderr}`);
		}
	},

	/**
	 * Pull from remote tracking branch
	 */
	async pull(branch: string): Promise<void> {
		// Checkout the branch first
		await this.checkout(branch);

		const result = await execInteractive(["pull"]);
		if (!result.success) {
			throw new Error(`Failed to pull ${branch}: ${result.stderr}`);
		}
	},

	/**
	 * Get the remote tracking branch for a local branch
	 * Returns null if no tracking branch configured
	 */
	async getTrackingBranch(branch: string): Promise<string | null> {
		const result = await exec(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
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
				? (await exec(["log", "--oneline", `${remote}..${local}`, "-5"])).stdout.split("\n").filter(Boolean)
				: [];
		const remoteCommits =
			remoteOnly > 0
				? (await exec(["log", "--oneline", `${local}..${remote}`, "-5"])).stdout.split("\n").filter(Boolean)
				: [];

		return { localOnly, remoteOnly, localCommits, remoteCommits };
	},

	/**
	 * Get list of commits between two refs
	 */
	async getCommitsBetween(from: string, to: string, limit = 10): Promise<string[]> {
		const result = await exec(["log", "--oneline", `${from}..${to}`, `-${limit}`]);
		return result.success ? result.stdout.split("\n").filter(Boolean) : [];
	},

	/**
	 * Get branches that contain a specific commit
	 */
	async branchesContaining(sha: string): Promise<string[]> {
		const result = await exec(["branch", "--contains", sha, "--format=%(refname:short)"]);
		if (!result.success) {
			return [];
		}
		return result.stdout.split("\n").filter((l) => l.trim());
	},

	/**
	 * Check if commit A is ancestor of commit B
	 */
	async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
		const result = await exec(["merge-base", "--is-ancestor", ancestor, descendant]);
		return result.success;
	},

	/**
	 * Find potential child branches of a parent branch
	 * A child branch is one where:
	 * 1. Parent's HEAD is an ancestor of the child (child was branched FROM parent)
	 * 2. The child has commits beyond the parent's HEAD
	 */
	async findPotentialChildren(parentBranch: string): Promise<Array<{ name: string; commitsAhead: number }>> {
		const branches = await this.getBranches();
		const parentSha = await this.getSha(parentBranch);
		const children: Array<{ name: string; commitsAhead: number }> = [];

		for (const branch of branches) {
			if (branch.name === parentBranch) continue;

			try {
				// Key check: parent must be an ancestor of this branch
				// This means the branch was created FROM the parent
				const parentIsAncestor = await this.isAncestor(parentSha, branch.sha);
				if (!parentIsAncestor) continue;

				// Count commits this branch has beyond parent's HEAD
				const commitsAhead = await this.countCommits(parentSha, branch.name);
				if (commitsAhead > 0) {
					children.push({ name: branch.name, commitsAhead });
				}
			} catch {
				// Skip branches that don't share history
				continue;
			}
		}

		return children.sort((a, b) => a.name.localeCompare(b.name));
	},
};
