import chalk from "chalk";
import { search, checkbox, confirm, input, select } from "@inquirer/prompts";
import { git } from "./git";
import type { PlanStep } from "./types";

/**
 * Prompt helpers for git-rebase-multiple
 */
export const prompts = {
	/**
	 * Select parent branch to rebase
	 */
	async selectParentBranch(): Promise<string> {
		const branches = await git.getBranches();
		const currentBranch = await git.getCurrentBranch();

		const allChoices = branches.map((b) => ({
			value: b.name,
			name: b.name + (b.isCurrent ? chalk.dim(" (current)") : ""),
		}));

		return search({
			message: "Which branch do you want to rebase?",
			source: async (term) => {
				if (!term) return allChoices;
				const lower = term.toLowerCase();
				return allChoices.filter((c) => c.value.toLowerCase().includes(lower));
			},
			default: currentBranch,
		});
	},

	/**
	 * Select target branch to rebase onto
	 */
	async selectTargetBranch(excludeBranch: string): Promise<string> {
		const branches = await git.getBranches();

		const allChoices = branches
			.filter((b) => b.name !== excludeBranch)
			.map((b) => ({
				value: b.name,
				name: b.name,
			}));

		return search({
			message: "Onto which branch?",
			source: async (term) => {
				if (!term) return allChoices;
				const lower = term.toLowerCase();
				return allChoices.filter((c) => c.value.toLowerCase().includes(lower));
			},
		});
	},

	/**
	 * Select child branches that depend on parent
	 */
	async selectChildBranches(
		parentBranch: string,
		potentialChildren: Array<{ name: string; commitsAhead: number }>
	): Promise<string[]> {
		if (potentialChildren.length === 0) {
			console.log(chalk.yellow("\nNo dependent branches found."));
			return [];
		}

		console.log(chalk.dim(`\nFound ${potentialChildren.length} branches that may depend on ${parentBranch}:`));

		return checkbox({
			message: "Select child branches to rebase (space to toggle):",
			choices: potentialChildren.map((child) => ({
				value: child.name,
				name: `${child.name} ${chalk.dim(`(${child.commitsAhead} commits ahead)`)}`,
				checked: true, // Pre-select all
			})),
		});
	},

	/**
	 * Show execution plan and confirm
	 */
	async confirmPlan(_config: unknown, steps: PlanStep[]): Promise<boolean> {
		console.log(chalk.bold("\n📝 Execution Plan:\n"));

		for (const step of steps) {
			console.log(chalk.cyan(`  Step ${step.stepNumber}:`) + ` ${step.description}`);
			if (step.command) {
				console.log(chalk.dim(`         ${step.command}`));
			}
		}

		console.log(chalk.yellow("\n⚠️  You can abort at ANY step with: tools git-rebase-multiple --abort"));

		return confirm({
			message: "Continue?",
			default: true,
		});
	},

	/**
	 * Wait for user to press Enter
	 */
	async pressEnterToContinue(message = "Press Enter to continue..."): Promise<void> {
		await input({
			message: chalk.dim(message),
		});
	},

	/**
	 * Confirm abort operation
	 */
	async confirmAbort(): Promise<boolean> {
		return confirm({
			message: "This will restore all branches to their original state. Continue?",
			default: true,
		});
	},

	/**
	 * Select cleanup options
	 */
	async selectCleanupOption(): Promise<"keep" | "delete-all" | "delete-tags-only"> {
		return select({
			message: "What would you like to do with backup refs?",
			choices: [
				{ value: "keep" as const, name: "Keep backups (recommended)" },
				{ value: "delete-all" as const, name: "Delete all backups and fork tags" },
				{ value: "delete-tags-only" as const, name: "Delete only fork tags, keep branch backups" },
			],
		});
	},

	/**
	 * Select a branch to restore
	 */
	async selectBranchToRestore(branches: string[]): Promise<string> {
		return select({
			message: "Which branch do you want to restore?",
			choices: branches.map((b) => ({ value: b, name: b })),
		});
	},

	/**
	 * Confirm continue after conflict resolution
	 */
	async confirmContinue(): Promise<boolean> {
		return confirm({
			message: "Have you resolved all conflicts and staged the changes?",
			default: true,
		});
	},
};
