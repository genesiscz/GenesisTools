import type { DetailedCommitInfo } from "@app/utils/git";

/** Parsed conventional commit with extracted metadata */
export interface ParsedCommit {
	/** Original commit info from git */
	commit: DetailedCommitInfo;
	/** Conventional commit type (feat, fix, chore, etc.) */
	type: string | null;
	/** Scope string from parentheses, e.g., "login, COL-123" */
	scope: string | null;
	/** Extracted ticket identifiers, e.g., ["COL-123"] */
	tickets: string[];
	/** The message body after "type(scope): " */
	body: string;
	/** Normalized group key for heuristic grouping */
	groupKey: string;
}

/** A group of commits that belong together */
export interface CommitGroup {
	/** Unique key for this group */
	key: string;
	/** Human-readable label for the group (shown in prompt) */
	label: string;
	/** Commits in this group */
	commits: ParsedCommit[];
	/** User-assigned branch name (set during interactive flow) */
	branchName?: string;
}

/** Configuration for the rebranch operation */
export interface RebranchConfig {
	/** The source/messy branch */
	sourceBranch: string;
	/** The base/parent branch (fork point origin) */
	baseBranch: string;
	/** SHA of the fork point */
	forkPointSha: string;
	/** Whether commits can appear in multiple branches */
	allowDuplicates: boolean;
	/** The groups with their assigned branch names and commits */
	groups: CommitGroup[];
	/** Branch to return to after completion */
	originalBranch: string;
}

/** Result of a single branch creation */
export interface BranchResult {
	branchName: string;
	commitsApplied: number;
	commitsFailed: number;
	success: boolean;
	errors: string[];
}
