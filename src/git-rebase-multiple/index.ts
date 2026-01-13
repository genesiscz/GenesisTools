import chalk from "chalk";
import { Command } from "commander";
import { backupManager } from "./backup";
import { forkPointManager } from "./forkpoint";
import { git } from "./git";
import { prompts } from "./prompts";
import { stateManager } from "./state";
import type { CLIOptions, PlanStep, RebaseConfig, RebaseSummary, RebaseState } from "./types";

/**
 * Show detailed help message (legacy)
 */
function showHelpOld(): void {
	console.log(`
${chalk.bold("git-rebase-multiple")} - Safe branch hierarchy rebasing

${chalk.bold("USAGE:")}
  tools git-rebase-multiple [options]

${chalk.bold("OPTIONS:")}
  --help-old              Show this detailed help message
  -a, --abort             Abort and restore all branches to original state
  -c, --continue          Continue after resolving conflicts
  -s, --status            Show current state and existing backups
  --cleanup               Remove all backup refs and fork tags
  -r, --restore <branch>  Restore single branch from backup
  --dry-run               Show execution plan without running

${chalk.bold("NON-INTERACTIVE MODE:")}
  --parent <branch>       Parent branch to rebase
  --target <branch>       Target branch to rebase onto
  --children <a,b,c>      Comma-separated child branches

${chalk.bold("EXAMPLES:")}
  tools git-rebase-multiple              # Interactive mode
  tools git-rebase-multiple --abort      # Restore everything
  tools git-rebase-multiple --status     # Show backups/state
  tools git-rebase-multiple --dry-run    # Preview plan
`);
}

/**
 * Show current status
 */
async function showStatus(): Promise<void> {
	console.log(chalk.bold("\n📊 Git Rebase Multiple - Status\n"));

	// Check for in-progress state
	const state = await stateManager.load();
	if (state) {
		console.log(chalk.yellow("⚠️  Operation in progress!\n"));
		console.log(`  Phase: ${chalk.cyan(state.phase)}`);
		console.log(`  Started: ${state.startedAt}`);
		console.log(`  Parent: ${chalk.cyan(state.parentBranch)} → ${chalk.cyan(state.targetBranch)}`);
		console.log(`  Children: ${state.childBranches.join(", ") || "(none)"}`);
		console.log(`  Completed: ${state.completed.join(", ") || "(none)"}`);
		console.log(`  Pending: ${state.pending.join(", ") || "(none)"}`);
		if (state.currentChild) {
			console.log(`  Currently rebasing: ${chalk.yellow(state.currentChild)}`);
		}
		console.log();
	}

	// List backups
	const backups = await backupManager.listBackups();
	if (backups.length > 0) {
		console.log(chalk.bold("📦 Backup refs:"));
		for (const backup of backups) {
			const shortSha = backup.sha.substring(0, 7);
			console.log(`  ${backup.branch}: ${chalk.dim(shortSha)} (${chalk.dim(backup.ref)})`);
		}
		console.log();
	} else {
		console.log(chalk.dim("No backup refs found.\n"));
	}

	// List fork points
	const forkPoints = await forkPointManager.list();
	if (forkPoints.length > 0) {
		console.log(chalk.bold("📍 Fork point tags:"));
		for (const fp of forkPoints) {
			const shortSha = fp.forkPointSha.substring(0, 7);
			console.log(`  ${fp.tagName}: ${chalk.dim(shortSha)}`);
		}
		console.log();
	}

	// Check if rebase is in progress
	const rebaseInProgress = await git.isRebaseInProgress();
	if (rebaseInProgress) {
		console.log(chalk.yellow("⚠️  Git rebase is currently in progress."));
		console.log(chalk.dim("   Run 'git rebase --continue' after resolving conflicts"));
		console.log(chalk.dim("   Or 'tools git-rebase-multiple --abort' to restore everything"));
	}
}

/**
 * Abort operation and restore all branches
 */
async function abort(): Promise<void> {
	console.log(chalk.bold("\n🛑 Aborting git-rebase-multiple operation...\n"));

	// Abort any in-progress rebase
	const rebaseInProgress = await git.isRebaseInProgress();
	if (rebaseInProgress) {
		console.log("  Aborting in-progress rebase...");
		await git.rebaseAbort();
	}

	// Load state to know what to restore
	const state = await stateManager.load();

	if (state) {
		// Restore branches from backups
		const branchesToRestore = Object.keys(state.backups);
		if (branchesToRestore.length > 0) {
			console.log("\n📦 Restoring branches from backups:");
			for (const branch of branchesToRestore) {
				try {
					console.log(`  Restoring ${chalk.cyan(branch)}...`);
					await backupManager.restoreBackup(branch);
					console.log(`  ${chalk.green("✓")} ${branch} restored`);
				} catch (error) {
					console.log(`  ${chalk.red("✗")} Failed to restore ${branch}: ${error}`);
				}
			}
		}

		// Return to original branch
		try {
			await git.checkout(state.originalBranch);
			console.log(`\n  Returned to ${chalk.cyan(state.originalBranch)}`);
		} catch {
			// Ignore - branch might not exist
		}

		// Clear state file
		await stateManager.clear();
	} else {
		// No state - try to restore from backup refs
		const backups = await backupManager.listBackups();
		if (backups.length > 0) {
			const confirmed = await prompts.confirmAbort();
			if (!confirmed) {
				console.log(chalk.yellow("\nAbort cancelled."));
				return;
			}

			console.log("\n📦 Restoring branches from backups:");
			for (const backup of backups) {
				try {
					console.log(`  Restoring ${chalk.cyan(backup.branch)}...`);
					await backupManager.restoreBackup(backup.branch);
					console.log(`  ${chalk.green("✓")} ${backup.branch} restored`);
				} catch (error) {
					console.log(`  ${chalk.red("✗")} Failed to restore ${backup.branch}: ${error}`);
				}
			}
		} else {
			console.log(chalk.yellow("No operation in progress and no backups found."));
			return;
		}
	}

	// Clean up fork point tags
	console.log("\n🧹 Cleaning up fork point tags...");
	await forkPointManager.cleanup();

	console.log(chalk.green("\n✅ Abort complete! All branches restored to original state."));
}

/**
 * Continue after conflict resolution
 */
async function continueRebase(): Promise<void> {
	const state = await stateManager.load();

	if (!state) {
		console.log(chalk.red("No rebase operation in progress."));
		process.exit(1);
	}

	// Check if there are still conflicts
	const rebaseInProgress = await git.isRebaseInProgress();
	if (rebaseInProgress) {
		// Continue the git rebase
		console.log(chalk.bold("\n🔄 Continuing rebase...\n"));
		const result = await git.rebaseContinue();

		if (!result.success) {
			console.log(chalk.yellow("\n⚠️  Rebase still has conflicts."));
			console.log(chalk.dim("   1. Resolve remaining conflicts"));
			console.log(chalk.dim("   2. Run: git add ."));
			console.log(chalk.dim("   3. Run: tools git-rebase-multiple --continue"));
			process.exit(1);
		}
	}

	// Mark current item as completed and continue
	if (state.phase === "PARENT_REBASE") {
		await stateManager.markCompleted(state.parentBranch);
		console.log(chalk.green(`✅ ${state.parentBranch} rebased successfully!`));
	} else if (state.currentChild) {
		await stateManager.markCompleted(state.currentChild);
		console.log(chalk.green(`✅ ${state.currentChild} rebased successfully!`));
	}

	// Continue with remaining children
	const updatedState = await stateManager.load();
	if (updatedState && updatedState.pending.length > 0) {
		await executeChildRebases(updatedState);
	} else {
		await finalize(updatedState!);
	}
}

/**
 * Cleanup all backup refs and fork tags
 */
async function cleanup(): Promise<void> {
	console.log(chalk.bold("\n🧹 Cleaning up...\n"));

	const backups = await backupManager.listBackups();
	const forkPoints = await forkPointManager.list();

	if (backups.length === 0 && forkPoints.length === 0) {
		console.log(chalk.dim("Nothing to clean up."));
		return;
	}

	console.log(`Found ${backups.length} backup refs and ${forkPoints.length} fork point tags.`);

	const option = await prompts.selectCleanupOption();

	if (option === "keep") {
		console.log(chalk.dim("\nNothing changed."));
		return;
	}

	if (option === "delete-all" || option === "delete-tags-only") {
		console.log("\nDeleting fork point tags...");
		await forkPointManager.cleanup();
	}

	if (option === "delete-all") {
		console.log("Deleting backup refs...");
		await backupManager.cleanup();
	}

	// Clear state file if exists
	await stateManager.clear();

	console.log(chalk.green("\n✅ Cleanup complete!"));
}

/**
 * Restore a single branch from backup
 */
async function restoreSingleBranch(branch?: string): Promise<void> {
	const backups = await backupManager.listBackups();

	if (backups.length === 0) {
		console.log(chalk.red("No backup refs found."));
		process.exit(1);
	}

	const branchToRestore = branch || (await prompts.selectBranchToRestore(backups.map((b) => b.branch)));

	const backup = backups.find((b) => b.branch === branchToRestore);
	if (!backup) {
		console.log(chalk.red(`No backup found for branch: ${branchToRestore}`));
		process.exit(1);
	}

	console.log(`\nRestoring ${chalk.cyan(branchToRestore)} to ${chalk.dim(backup.sha.substring(0, 7))}...`);
	await backupManager.restoreBackup(branchToRestore);
	console.log(chalk.green(`\n✅ ${branchToRestore} restored!`));
}

/**
 * Generate execution plan steps
 */
function generatePlanSteps(config: RebaseConfig): PlanStep[] {
	const steps: PlanStep[] = [];
	let stepNum = 1;

	steps.push({
		stepNumber: stepNum++,
		description: "Create backup refs",
		branches: [config.parentBranch, ...config.childBranches],
	});

	if (config.childBranches.length > 0) {
		steps.push({
			stepNumber: stepNum++,
			description: "Save fork points for each child",
			branches: config.childBranches,
		});
	}

	steps.push({
		stepNumber: stepNum++,
		description: `Rebase ${config.parentBranch} onto ${config.targetBranch}`,
		command: `git rebase ${config.targetBranch}`,
	});

	for (const child of config.childBranches) {
		steps.push({
			stepNumber: stepNum++,
			description: `Rebase ${child} onto new ${config.parentBranch}`,
			command: `git rebase --onto ${config.parentBranch} fork/${child}`,
		});
	}

	steps.push({
		stepNumber: stepNum++,
		description: "Cleanup (optional)",
	});

	return steps;
}

/**
 * Execute parent rebase
 */
async function executeParentRebase(state: RebaseState): Promise<boolean> {
	console.log(chalk.bold(`\n🔄 Rebasing ${state.parentBranch} onto ${state.targetBranch}...`));
	console.log(chalk.dim(`   git checkout ${state.parentBranch}`));
	console.log(chalk.dim(`   git rebase ${state.targetBranch}\n`));

	await git.checkout(state.parentBranch);
	const result = await git.rebase(state.targetBranch);

	if (!result.success) {
		console.log(chalk.yellow("\n⚠️  Conflicts detected!"));
		console.log(chalk.dim("   1. Resolve conflicts in your editor"));
		console.log(chalk.dim("   2. Run: git add . && git rebase --continue"));
		console.log(chalk.dim("   3. Then run: tools git-rebase-multiple --continue"));
		console.log(chalk.dim("\n   Or abort: tools git-rebase-multiple --abort"));

		await stateManager.updatePhase("PARENT_REBASE");
		return false;
	}

	await stateManager.markCompleted(state.parentBranch);
	const commits = await git.countCommits(state.targetBranch, state.parentBranch);
	console.log(chalk.green(`\n✅ ${state.parentBranch} rebased successfully! (${commits} commits)`));

	return true;
}

/**
 * Execute child rebases
 */
async function executeChildRebases(state: RebaseState): Promise<boolean> {
	const children = state.pending.filter((b) => b !== state.parentBranch);

	for (const child of children) {
		const forkPoint = state.forkPoints[child];
		if (!forkPoint) {
			console.log(chalk.red(`\n✗ No fork point found for ${child}. Skipping.`));
			continue;
		}

		await stateManager.setCurrentChild(child);

		console.log(chalk.bold(`\n🔄 Rebasing ${child} onto ${state.parentBranch}...`));
		console.log(chalk.dim(`   git checkout ${child}`));
		console.log(chalk.dim(`   git rebase --onto ${state.parentBranch} fork/${child}\n`));

		await git.checkout(child);
		const result = await git.rebaseOnto(state.parentBranch, `fork/${child}`);

		if (!result.success) {
			console.log(chalk.yellow("\n⚠️  Conflicts detected!"));
			console.log(chalk.dim("   1. Resolve conflicts in your editor"));
			console.log(chalk.dim("   2. Run: git add . && git rebase --continue"));
			console.log(chalk.dim("   3. Then run: tools git-rebase-multiple --continue"));
			console.log(chalk.dim("\n   Or abort: tools git-rebase-multiple --abort"));
			return false;
		}

		await stateManager.markCompleted(child);
		const commits = await git.countCommits(state.parentBranch, child);
		console.log(chalk.green(`✅ ${child} rebased successfully! (${commits} commits)`));

		// Pause between children for user review
		if (children.indexOf(child) < children.length - 1) {
			await prompts.pressEnterToContinue("Press Enter for next child branch...");
		}
	}

	return true;
}

/**
 * Finalize the operation
 */
async function finalize(state: RebaseState): Promise<void> {
	await stateManager.updatePhase("CLEANUP");

	console.log(chalk.bold("\n🧹 Cleanup\n"));

	const option = await prompts.selectCleanupOption();

	if (option === "delete-all" || option === "delete-tags-only") {
		await forkPointManager.cleanup();
	}

	if (option === "delete-all") {
		await backupManager.cleanup();
	}

	// Show summary
	const summaries: RebaseSummary[] = [];

	// Parent
	const parentCommits = await git.countCommits(state.targetBranch, state.parentBranch);
	summaries.push({
		branch: state.parentBranch,
		commitsApplied: parentCommits,
		success: state.completed.includes(state.parentBranch),
	});

	// Children
	for (const child of state.childBranches) {
		const childCommits = await git.countCommits(state.parentBranch, child);
		summaries.push({
			branch: child,
			commitsApplied: childCommits,
			success: state.completed.includes(child),
		});
	}

	console.log(chalk.bold("\n✅ Complete! Summary:\n"));
	for (const summary of summaries) {
		const status = summary.success ? chalk.green("✓") : chalk.red("✗");
		console.log(`   ${status} ${summary.branch}: ${summary.commitsApplied} commits`);
	}

	if (option === "keep") {
		console.log(chalk.dim(`\n   Backups available at refs/backup/grm/*`));
		console.log(chalk.dim(`   Run --cleanup when you're confident everything is correct.`));
	}

	// Clear state
	await stateManager.clear();

	// Return to original branch
	try {
		await git.checkout(state.originalBranch);
		console.log(chalk.dim(`\n   Returned to ${state.originalBranch}`));
	} catch {
		// Ignore
	}
}

/**
 * Run the interactive flow
 */
async function runInteractive(dryRun = false): Promise<void> {
	console.log(chalk.bold("\n📋 Git Rebase Multiple - Safe Branch Hierarchy Rebasing\n"));

	// Check preconditions
	const hasChanges = await git.hasUncommittedChanges();
	if (hasChanges) {
		console.log(chalk.red("✗ You have uncommitted changes. Please commit or stash them first."));
		process.exit(1);
	}

	const rebaseInProgress = await git.isRebaseInProgress();
	if (rebaseInProgress) {
		console.log(chalk.red("✗ A rebase is already in progress. Complete or abort it first."));
		console.log(chalk.dim("   Run: git rebase --continue OR git rebase --abort"));
		process.exit(1);
	}

	// Check for existing state
	const existingState = await stateManager.load();
	if (existingState) {
		console.log(chalk.yellow("⚠️  An operation is already in progress."));
		console.log(chalk.dim("   Run: tools git-rebase-multiple --continue"));
		console.log(chalk.dim("   Or:  tools git-rebase-multiple --abort"));
		process.exit(1);
	}

	// Gather info
	const originalBranch = await git.getCurrentBranch();
	const parentBranch = await prompts.selectParentBranch();
	const targetBranch = await prompts.selectTargetBranch(parentBranch);

	// Find potential children
	console.log(chalk.dim("\nAnalyzing branch dependencies..."));
	const potentialChildren = await git.findPotentialChildren(parentBranch);
	const childBranches = await prompts.selectChildBranches(parentBranch, potentialChildren);

	const config: RebaseConfig = {
		parentBranch,
		targetBranch,
		childBranches,
	};

	// Generate and show plan
	const steps = generatePlanSteps(config);
	const confirmed = await prompts.confirmPlan(config, steps);

	if (!confirmed) {
		console.log(chalk.yellow("\nOperation cancelled."));
		process.exit(0);
	}

	if (dryRun) {
		console.log(chalk.cyan("\n[Dry run] No changes made."));
		process.exit(0);
	}

	// Step 1: Create backups
	console.log(chalk.bold("\n📦 Step 1: Creating backup refs...\n"));
	const branchesToBackup = [parentBranch, ...childBranches];
	const backups: Record<string, string> = {};

	for (const branch of branchesToBackup) {
		const backup = await backupManager.createBackup(branch);
		backups[branch] = backup.sha;
		console.log(`   ${chalk.green("✓")} ${branch} → ${chalk.dim(backup.ref)}`);
	}

	// Step 2: Save fork points
	const forkPoints: Record<string, string> = {};
	if (childBranches.length > 0) {
		console.log(chalk.bold("\n📍 Step 2: Saving fork points...\n"));
		for (const child of childBranches) {
			const info = await forkPointManager.save(parentBranch, child);
			forkPoints[child] = info.forkPointSha;
			console.log(
				`   ${chalk.green("✓")} ${child}: ${chalk.dim(info.forkPointSha.substring(0, 7))} (${info.commitsAhead} commits ahead)`
			);
		}
	}

	// Create state
	const state = await stateManager.create({
		parentBranch,
		targetBranch,
		childBranches,
		backups,
		forkPoints,
		originalBranch,
	});

	await prompts.pressEnterToContinue();

	// Step 3: Rebase parent
	await stateManager.updatePhase("PARENT_REBASE");
	const parentSuccess = await executeParentRebase(state);
	if (!parentSuccess) {
		process.exit(1);
	}

	// Step 4+: Rebase children
	if (childBranches.length > 0) {
		await prompts.pressEnterToContinue("Press Enter to continue to child branches...");

		const updatedState = await stateManager.load();
		const childrenSuccess = await executeChildRebases(updatedState!);
		if (!childrenSuccess) {
			process.exit(1);
		}
	}

	// Finalize
	const finalState = await stateManager.load();
	await finalize(finalState!);
}

/**
 * Run in non-interactive mode
 */
async function runNonInteractive(options: CLIOptions): Promise<void> {
	const { parent, target, children } = options;

	if (!parent || !target) {
		console.log(chalk.red("✗ --parent and --target are required in non-interactive mode."));
		process.exit(1);
	}

	// Validate branches exist
	if (!(await git.branchExists(parent))) {
		console.log(chalk.red(`✗ Branch does not exist: ${parent}`));
		process.exit(1);
	}
	if (!(await git.branchExists(target))) {
		console.log(chalk.red(`✗ Branch does not exist: ${target}`));
		process.exit(1);
	}

	const childBranches = children ? children.split(",").map((c) => c.trim()) : [];
	for (const child of childBranches) {
		if (!(await git.branchExists(child))) {
			console.log(chalk.red(`✗ Branch does not exist: ${child}`));
			process.exit(1);
		}
	}

	// Run the same flow as interactive but with pre-defined values
	console.log(chalk.bold("\n📋 Git Rebase Multiple - Non-Interactive Mode\n"));
	console.log(`  Parent: ${chalk.cyan(parent)} → ${chalk.cyan(target)}`);
	console.log(`  Children: ${childBranches.join(", ") || "(none)"}\n`);

	// Check preconditions
	const hasChanges = await git.hasUncommittedChanges();
	if (hasChanges) {
		console.log(chalk.red("✗ You have uncommitted changes. Please commit or stash them first."));
		process.exit(1);
	}

	// Similar flow as interactive, but without prompts for branch selection
	// For brevity, reuse the interactive flow after setting up
	console.log(chalk.yellow("Non-interactive mode executes the same steps as interactive mode."));
	console.log(chalk.dim("Use --dry-run first to preview the plan.\n"));

	// For now, require interactive confirmation for safety
	console.log(chalk.red("Non-interactive mode without --dry-run is not yet implemented."));
	console.log(chalk.dim("Use interactive mode for full functionality."));
	process.exit(1);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
	const program = new Command()
		.name("git-rebase-multiple")
		.description("Safe branch hierarchy rebasing")
		.option("-a, --abort", "Abort and restore all branches to original state")
		.option("-c, --continue", "Continue after resolving conflicts")
		.option("-s, --status", "Show current state and existing backups")
		.option("-r, --restore [branch]", "Restore single branch from backup")
		.option("--cleanup", "Remove all backup refs and fork tags")
		.option("--dry-run", "Show execution plan without running")
		.option("--parent <branch>", "Parent branch to rebase")
		.option("--target <branch>", "Target branch to rebase onto")
		.option("--children <branches>", "Comma-separated child branches")
		.option("--help-old", "Show detailed help message")
		.parse();

	const options = program.opts<CLIOptions & { helpOld?: boolean }>();

	try {
		if (options.helpOld) {
			showHelpOld();
			process.exit(0);
		}

		if (options.status) {
			await showStatus();
			process.exit(0);
		}

		if (options.abort) {
			await abort();
			process.exit(0);
		}

		if (options.continue) {
			await continueRebase();
			process.exit(0);
		}

		if (options.cleanup) {
			await cleanup();
			process.exit(0);
		}

		if (options.restore !== undefined) {
			await restoreSingleBranch(options.restore || undefined);
			process.exit(0);
		}

		// Check if non-interactive mode
		if (options.parent || options.target) {
			await runNonInteractive({ ...options, dryRun: options.dryRun });
		} else {
			await runInteractive(options.dryRun);
		}
	} catch (error) {
		if (error instanceof Error) {
			if (error.message === "canceled" || error.message === "") {
				console.log(chalk.yellow("\n🚫 Operation cancelled."));
				process.exit(0);
			}
			console.log(chalk.red(`\n✗ Error: ${error.message}`));
		} else {
			console.log(chalk.red(`\n✗ Error: ${error}`));
		}
		process.exit(1);
	}
}

main();
