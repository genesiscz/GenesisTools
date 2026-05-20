import { inquirerBackend } from "@app/utils/prompts/p/inquirer-backend";
import * as p from "@app/utils/prompts/p";
import chalk from "chalk";
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

        return inquirerBackend.search({
            message: "Which branch do you want to rebase?",
            options: async (term) => {
                const filtered = !term
                    ? allChoices
                    : allChoices.filter((c) => c.value.toLowerCase().includes(term.toLowerCase()));
                return filtered.map((c) => ({ value: c.value, label: c.name }));
            },
        }) as Promise<string>;
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

        return inquirerBackend.search({
            message: "Onto which branch?",
            options: async (term) => {
                const filtered = !term
                    ? allChoices
                    : allChoices.filter((c) => c.value.toLowerCase().includes(term.toLowerCase()));
                return filtered.map((c) => ({ value: c.value, label: c.name }));
            },
        }) as Promise<string>;
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

        return p.multiselect({
            message: "Select child branches to rebase (space to toggle):",
            options: potentialChildren.map((child) => ({
                value: child.name,
                label: `${child.name} ${chalk.dim(`(${child.commitsAhead} commits ahead)`)}`,
            })),
            initialValues: potentialChildren.map((child) => child.name),
        }) as Promise<string[]>;
    },

    /**
     * Show execution plan and confirm
     */
    async confirmPlan(_config: unknown, steps: PlanStep[]): Promise<boolean> {
        console.log(chalk.bold("\n📝 Execution Plan:\n"));

        for (const step of steps) {
            console.log(`${chalk.cyan(`  Step ${step.stepNumber}:`)} ${step.description}`);
            if (step.command) {
                console.log(chalk.dim(`         ${step.command}`));
            }
        }

        console.log(chalk.yellow("\n⚠️  You can abort at ANY step with: tools git-rebase-multiple --abort"));

        return p.confirm({
            message: "Continue?",
            initialValue: true,
        });
    },

    /**
     * Wait for user to press Enter
     */
    async pressEnterToContinue(message = "Press Enter to continue..."): Promise<void> {
        await p.text({
            message: chalk.dim(message),
        });
    },

    /**
     * Confirm abort operation
     */
    async confirmAbort(): Promise<boolean> {
        return p.confirm({
            message: "This will restore all branches to their original state. Continue?",
            initialValue: true,
        });
    },

    /**
     * When aborting with uncommitted changes, ask how to handle them
     */
    async selectAbortAction(): Promise<"stash" | "discard" | "cancel"> {
        return p.select({
            message: "Uncommitted changes detected. How do you want to proceed?",
            options: [
                {
                    value: "stash" as const,
                    label: "Stash changes (recover later with 'git stash pop')",
                },
                {
                    value: "discard" as const,
                    label: "Discard changes (cannot be recovered)",
                },
                {
                    value: "cancel" as const,
                    label: "Cancel abort (keep current state)",
                },
            ],
        }) as Promise<"stash" | "discard" | "cancel">;
    },

    /**
     * Confirm proceeding when local branch diverges from remote
     */
    async confirmDivergence(): Promise<boolean> {
        return p.select({
            message: "Your branch diverges from remote. Continue with rebase?",
            options: [
                {
                    value: true as unknown as string,
                    label: "Yes, continue (will require 'git push --force' later)",
                },
                {
                    value: false as unknown as string,
                    label: "No, cancel (consider 'git pull' first)",
                },
            ],
        }) as unknown as Promise<boolean>;
    },

    /**
     * Select cleanup options
     */
    async selectCleanupOption(): Promise<"keep" | "delete-all" | "delete-tags-only"> {
        return p.select({
            message: "What would you like to do with backup refs?",
            options: [
                { value: "keep" as const, label: "Keep backups (recommended)" },
                { value: "delete-all" as const, label: "Delete all backups and fork tags" },
                { value: "delete-tags-only" as const, label: "Delete only fork tags, keep branch backups" },
            ],
        }) as Promise<"keep" | "delete-all" | "delete-tags-only">;
    },

    /**
     * Select a branch to restore
     */
    async selectBranchToRestore(branches: string[]): Promise<string> {
        return p.select({
            message: "Which branch do you want to restore?",
            options: branches.map((b) => ({ value: b, label: b })),
        }) as Promise<string>;
    },

    /**
     * Confirm continue after conflict resolution
     */
    async confirmContinue(): Promise<boolean> {
        return p.confirm({
            message: "Have you resolved all conflicts and staged the changes?",
            initialValue: true,
        });
    },

    /**
     * Ask what to do about target branch divergence
     */
    async selectTargetDivergenceAction(): Promise<"pull" | "reset" | "skip" | "cancel"> {
        const answer = await p.select({
            message: "Target branch diverges from remote. What would you like to do?",
            options: [
                {
                    value: "pull",
                    label: "Pull from remote (git pull - merge remote changes)",
                },
                {
                    value: "reset",
                    label: "Reset to remote (git reset --hard - discard local changes)",
                },
                {
                    value: "skip",
                    label: "Skip sync (proceed with local version)",
                },
                {
                    value: "cancel",
                    label: "Cancel operation",
                },
            ],
        }) as "pull" | "reset" | "skip" | "cancel";

        return answer;
    },
};
