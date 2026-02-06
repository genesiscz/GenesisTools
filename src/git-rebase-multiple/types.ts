/**
 * Phase of the rebase operation
 */
export type RebasePhase =
	| "INIT"
	| "BACKUP"
	| "SAVE_FORK_POINTS"
	| "PARENT_REBASE"
	| "CHILD_REBASE"
	| "CLEANUP"
	| "COMPLETE"
	| "ABORTED";

/**
 * Configuration for a rebase operation
 */
export interface RebaseConfig {
	parentBranch: string;
	targetBranch: string;
	childBranches: string[];
}

/**
 * Information about a backup reference
 */
export interface BackupInfo {
	branch: string;
	sha: string;
	ref: string;
}

/**
 * Information about a fork point
 */
export interface ForkPointInfo {
	childBranch: string;
	forkPointSha: string;
	commitsAhead: number;
	tagName: string;
}

/**
 * Summary of a rebased branch
 */
export interface RebaseSummary {
	branch: string;
	commitsApplied: number;
	success: boolean;
	error?: string;
}

/**
 * State persisted to disk for resume/abort
 */
export interface RebaseState {
	startedAt: string;
	phase: RebasePhase;
	parentBranch: string;
	targetBranch: string;
	childBranches: string[];
	backups: Record<string, string>; // branch -> sha
	forkPoints: Record<string, string>; // childBranch -> forkPointSha
	completed: string[]; // completed branches
	pending: string[]; // pending branches
	currentChild?: string; // currently rebasing child
	originalBranch: string; // branch to return to after completion
}

/**
 * Options for CLI
 */
export interface CLIOptions {
	help?: boolean;
	abort?: boolean;
	continue?: boolean;
	status?: boolean;
	cleanup?: boolean;
	restore?: string;
	dryRun?: boolean;
	parent?: string;
	target?: string;
	children?: string;
}

// Shared types re-exported for backward compatibility
export type { ExecResult as GitCommandResult } from "@app/utils/cli";
export type { BranchInfo } from "@app/utils/git";

/**
 * Execution plan step
 */
export interface PlanStep {
	stepNumber: number;
	description: string;
	command?: string;
	branches?: string[];
}
