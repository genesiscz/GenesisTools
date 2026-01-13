import { git } from "./git";
import type { ForkPointInfo } from "./types";

const FORK_TAG_PREFIX = "fork";

/**
 * Fork point manager for tracking merge-base between parent and children
 */
export const forkPointManager = {
	/**
	 * Get tag name for a child branch fork point
	 */
	getTagName(childBranch: string): string {
		return `${FORK_TAG_PREFIX}/${childBranch}`;
	},

	/**
	 * Calculate and save fork point for a child branch
	 */
	async save(parentBranch: string, childBranch: string): Promise<ForkPointInfo> {
		// Find merge-base between parent and child
		const forkPointSha = await git.mergeBase(parentBranch, childBranch);

		// Count commits child has ahead of fork point
		const commitsAhead = await git.countCommits(forkPointSha, childBranch);

		// Create a lightweight tag at the fork point
		const tagName = this.getTagName(childBranch);

		// Delete existing tag if present
		await git.deleteTag(tagName);

		// Create new tag
		await git.createTag(tagName, forkPointSha);

		return {
			childBranch,
			forkPointSha,
			commitsAhead,
			tagName,
		};
	},

	/**
	 * Save fork points for multiple children
	 */
	async saveAll(parentBranch: string, childBranches: string[]): Promise<ForkPointInfo[]> {
		const forkPoints: ForkPointInfo[] = [];
		for (const child of childBranches) {
			const info = await this.save(parentBranch, child);
			forkPoints.push(info);
		}
		return forkPoints;
	},

	/**
	 * Get saved fork point SHA for a child branch
	 */
	async get(childBranch: string): Promise<string | null> {
		const tagName = this.getTagName(childBranch);
		try {
			return await git.getSha(tagName);
		} catch {
			return null;
		}
	},

	/**
	 * Delete fork point tag for a child branch
	 */
	async delete(childBranch: string): Promise<void> {
		const tagName = this.getTagName(childBranch);
		await git.deleteTag(tagName);
	},

	/**
	 * Delete all fork point tags
	 */
	async cleanup(): Promise<void> {
		// List all tags with fork/ prefix
		const proc = Bun.spawn({
			cmd: ["git", "tag", "-l", `${FORK_TAG_PREFIX}/*`],
			stdio: ["ignore", "pipe", "pipe"],
		});

		const stdout = await new Response(proc.stdout).text();
		await proc.exited;

		const tags = stdout.split("\n").filter((t) => t.trim());
		for (const tag of tags) {
			await git.deleteTag(tag);
		}
	},

	/**
	 * List all existing fork point tags
	 */
	async list(): Promise<ForkPointInfo[]> {
		const proc = Bun.spawn({
			cmd: ["git", "tag", "-l", `${FORK_TAG_PREFIX}/*`],
			stdio: ["ignore", "pipe", "pipe"],
		});

		const stdout = await new Response(proc.stdout).text();
		await proc.exited;

		const tags = stdout.split("\n").filter((t) => t.trim());
		const forkPoints: ForkPointInfo[] = [];

		for (const tagName of tags) {
			const childBranch = tagName.replace(`${FORK_TAG_PREFIX}/`, "");
			try {
				const forkPointSha = await git.getSha(tagName);
				// Try to count commits ahead (branch might not exist anymore)
				let commitsAhead = 0;
				try {
					commitsAhead = await git.countCommits(forkPointSha, childBranch);
				} catch {
					// Branch might not exist
				}
				forkPoints.push({ childBranch, forkPointSha, commitsAhead, tagName });
			} catch {
				// Skip invalid tags
			}
		}

		return forkPoints;
	},
};
