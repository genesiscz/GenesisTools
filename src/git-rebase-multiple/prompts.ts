import chalk from "chalk";
import Enquirer from "enquirer";
import { git } from "./git";
import type { PlanStep } from "./types";

const enquirer = new Enquirer();

// Helper to bypass Enquirer's incomplete type definitions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prompt = <T>(options: Record<string, unknown>): Promise<T> => enquirer.prompt(options as any) as Promise<T>;

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

		const choices = branches.map((b) => ({
			name: b.name,
			message: b.name + (b.isCurrent ? chalk.dim(" (current)") : ""),
		}));

		const response = await prompt<{ branch: string }>({
			type: "autocomplete",
			name: "branch",
			message: "Which branch do you want to rebase?",
			choices,
			initial: currentBranch,
		});

		return response.branch;
	},

	/**
	 * Select target branch to rebase onto
	 */
	async selectTargetBranch(excludeBranch: string): Promise<string> {
		const branches = await git.getBranches();

		const choices = branches
			.filter((b) => b.name !== excludeBranch)
			.map((b) => ({
				name: b.name,
				message: b.name,
			}));

		const response = await prompt<{ branch: string }>({
			type: "autocomplete",
			name: "branch",
			message: "Onto which branch?",
			choices,
		});

		return response.branch;
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

		const choices = potentialChildren.map((child) => ({
			name: child.name,
			message: `${child.name} ${chalk.dim(`(${child.commitsAhead} commits ahead)`)}`,
			value: child.name,
		}));

		console.log(chalk.dim(`\nFound ${potentialChildren.length} branches that may depend on ${parentBranch}:`));

		const response = await prompt<{ children: string[] }>({
			type: "multiselect",
			name: "children",
			message: "Select child branches to rebase (space to toggle):",
			choices,
			initial: potentialChildren.map((c) => c.name),
		});

		return response.children;
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

		const response = await prompt<{ continue: boolean }>({
			type: "confirm",
			name: "continue",
			message: "Continue?",
			initial: true,
		});

		return response.continue;
	},

	/**
	 * Wait for user to press Enter
	 */
	async pressEnterToContinue(message = "Press Enter to continue..."): Promise<void> {
		await prompt({
			type: "input",
			name: "continue",
			message: chalk.dim(message),
		});
	},

	/**
	 * Confirm abort operation
	 */
	async confirmAbort(): Promise<boolean> {
		const response = await prompt<{ abort: boolean }>({
			type: "confirm",
			name: "abort",
			message: "This will restore all branches to their original state. Continue?",
			initial: true,
		});

		return response.abort;
	},

	/**
	 * Select cleanup options
	 */
	async selectCleanupOption(): Promise<"keep" | "delete-all" | "delete-tags-only"> {
		const response = await prompt<{ option: "keep" | "delete-all" | "delete-tags-only" }>({
			type: "select",
			name: "option",
			message: "What would you like to do with backup refs?",
			choices: [
				{ name: "keep", message: "Keep backups (recommended)" },
				{ name: "delete-all", message: "Delete all backups and fork tags" },
				{ name: "delete-tags-only", message: "Delete only fork tags, keep branch backups" },
			],
		});

		return response.option;
	},

	/**
	 * Select a branch to restore
	 */
	async selectBranchToRestore(branches: string[]): Promise<string> {
		const response = await prompt<{ branch: string }>({
			type: "select",
			name: "branch",
			message: "Which branch do you want to restore?",
			choices: branches.map((b) => ({ name: b, message: b })),
		});

		return response.branch;
	},

	/**
	 * Confirm continue after conflict resolution
	 */
	async confirmContinue(): Promise<boolean> {
		const response = await prompt<{ continue: boolean }>({
			type: "confirm",
			name: "continue",
			message: "Have you resolved all conflicts and staged the changes?",
			initial: true,
		});

		return response.continue;
	},
};
