import { runTool } from "@app/utils/cli";
import * as p from "@app/utils/prompts/p";
import { inquirerBackend } from "@app/utils/prompts/p/inquirer-backend";
import { handleReadmeFlag } from "@app/utils/readme";

// Use inquirer backend for this tool
p.setBackend(inquirerBackend);

import { out } from "@app/logger";
import chalk from "chalk";
import { Command } from "commander";
import { backupManager } from "./backup";
import { forkPointManager } from "./forkpoint";
import { git } from "./git";
import { prompts } from "./prompts";
import { stateManager } from "./state";
import type { CLIOptions, PlanStep, RebaseConfig, RebaseState, RebaseSummary } from "./types";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

/**
 * Show detailed help message (legacy)
 */
function showHelpFull(): void {
    out.print(`
${chalk.bold("git-rebase-multiple")} - Safe branch hierarchy rebasing

${chalk.bold("USAGE:")}
  tools git-rebase-multiple [options]

${chalk.bold("OPTIONS:")}
  -?, --help-full         Show this detailed help message
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
    out.print(chalk.bold("\n📊 Git Rebase Multiple - Status\n"));

    // Check for in-progress state
    const state = await stateManager.load();
    if (state) {
        out.print(chalk.yellow("⚠️  Operation in progress!\n"));
        out.print(`  Phase: ${chalk.cyan(state.phase)}`);
        out.print(`  Started: ${state.startedAt}`);
        out.print(`  Parent: ${chalk.cyan(state.parentBranch)} → ${chalk.cyan(state.targetBranch)}`);
        out.print(`  Children: ${state.childBranches.join(", ") || "(none)"}`);
        out.print(`  Completed: ${state.completed.join(", ") || "(none)"}`);
        out.print(`  Pending: ${state.pending.join(", ") || "(none)"}`);
        if (state.currentChild) {
            out.print(`  Currently rebasing: ${chalk.yellow(state.currentChild)}`);
        }
        out.print();
    }

    // List backups
    const backups = await backupManager.listBackups();
    if (backups.length > 0) {
        out.print(chalk.bold("📦 Backup refs:"));
        for (const backup of backups) {
            const shortSha = backup.sha.substring(0, 7);
            out.print(`  ${backup.branch}: ${chalk.dim(shortSha)} (${chalk.dim(backup.ref)})`);
        }
        out.print();
    } else {
        out.print(chalk.dim("No backup refs found.\n"));
    }

    // List fork points
    const forkPoints = await forkPointManager.list();
    if (forkPoints.length > 0) {
        out.print(chalk.bold("📍 Fork point tags:"));
        for (const fp of forkPoints) {
            const shortSha = fp.forkPointSha.substring(0, 7);
            out.print(`  ${fp.tagName}: ${chalk.dim(shortSha)}`);
        }
        out.print();
    }

    // Check if rebase is in progress
    const rebaseInProgress = await git.isRebaseInProgress();
    if (rebaseInProgress) {
        out.print(chalk.yellow("⚠️  Git rebase is currently in progress."));
        out.print(chalk.dim("   Run 'git rebase --continue' after resolving conflicts"));
        out.print(chalk.dim("   Or 'tools git-rebase-multiple --abort' to restore everything"));
    }
}

/**
 * Abort operation and restore all branches
 */
async function abort(): Promise<void> {
    out.print(chalk.bold("\n🛑 Aborting git-rebase-multiple operation...\n"));

    // 1. Abort any in-progress rebase FIRST
    const rebaseInProgress = await git.isRebaseInProgress();
    if (rebaseInProgress) {
        out.print("  Aborting in-progress rebase...");
        await git.rebaseAbort();
    }

    // 2. Handle uncommitted changes (may be left by failed rebase)
    const hasChanges = await git.hasUncommittedChanges();
    if (hasChanges) {
        out.print(chalk.yellow("\n⚠️  Uncommitted changes detected in working tree."));
        out.print(chalk.dim("   These may be from the failed rebase operation.\n"));

        const action = await prompts.selectAbortAction();

        if (action === "cancel") {
            out.print(chalk.yellow("\nAbort cancelled. Working tree unchanged."));
            return;
        }

        if (action === "stash") {
            out.print(chalk.dim("   Stashing changes..."));
            await git.stash("git-rebase-multiple: auto-stash during abort");
            out.print(chalk.green("   ✓ Changes stashed (restore with 'git stash pop')"));
        } else {
            // discard
            out.print(chalk.dim("   Discarding changes..."));
            await git.resetHard("HEAD");
            out.print(chalk.yellow("   ✓ Changes discarded"));
        }
    }

    // 3. Load state to know what to restore
    const state = await stateManager.load();

    if (state) {
        // Restore branches from backups
        const branchesToRestore = Object.keys(state.backups);
        if (branchesToRestore.length > 0) {
            out.print("\n📦 Restoring branches from backups:");
            for (const branch of branchesToRestore) {
                try {
                    out.print(`  Restoring ${chalk.cyan(branch)}...`);
                    await backupManager.restoreBackup(branch);
                    out.print(`  ${chalk.green("✓")} ${branch} restored`);
                } catch (error) {
                    out.print(`  ${chalk.red("✗")} Failed to restore ${branch}: ${error}`);
                }
            }
        }

        // Return to original branch
        try {
            await git.checkout(state.originalBranch);
            out.print(`\n  Returned to ${chalk.cyan(state.originalBranch)}`);
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
                out.print(chalk.yellow("\nAbort cancelled."));
                return;
            }

            out.print("\n📦 Restoring branches from backups:");
            for (const backup of backups) {
                try {
                    out.print(`  Restoring ${chalk.cyan(backup.branch)}...`);
                    await backupManager.restoreBackup(backup.branch);
                    out.print(`  ${chalk.green("✓")} ${backup.branch} restored`);
                } catch (error) {
                    out.print(`  ${chalk.red("✗")} Failed to restore ${backup.branch}: ${error}`);
                }
            }
        } else {
            out.print(chalk.yellow("No operation in progress and no backups found."));
            return;
        }
    }

    // 4. Clean up fork point tags
    out.print("\n🧹 Cleaning up fork point tags...");
    await forkPointManager.cleanup();

    out.print(chalk.green("\n✅ Abort complete! All branches restored to original state."));
}

/**
 * Continue after conflict resolution
 */
async function continueRebase(): Promise<void> {
    const state = await stateManager.load();

    if (!state) {
        out.print(chalk.red("No rebase operation in progress."));
        process.exit(1);
    }

    // Check if there are still conflicts
    const rebaseInProgress = await git.isRebaseInProgress();
    if (rebaseInProgress) {
        // Continue the git rebase
        out.print(chalk.bold("\n🔄 Continuing rebase...\n"));
        const result = await git.rebaseContinue();

        if (!result.success) {
            out.print(chalk.yellow("\n⚠️  Rebase still has conflicts."));
            out.print(chalk.dim("   1. Resolve remaining conflicts"));
            out.print(chalk.dim("   2. Run: git add ."));
            out.print(chalk.dim("   3. Run: tools git-rebase-multiple --continue"));
            process.exit(1);
        }
    }

    // Mark current item as completed and continue
    if (state.phase === "PARENT_REBASE") {
        await stateManager.markCompleted(state.parentBranch);
        out.print(chalk.green(`✅ ${state.parentBranch} rebased successfully!`));
    } else if (state.currentChild) {
        await stateManager.markCompleted(state.currentChild);
        out.print(chalk.green(`✅ ${state.currentChild} rebased successfully!`));
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
    out.print(chalk.bold("\n🧹 Cleaning up...\n"));

    const backups = await backupManager.listBackups();
    const forkPoints = await forkPointManager.list();

    if (backups.length === 0 && forkPoints.length === 0) {
        out.print(chalk.dim("Nothing to clean up."));
        return;
    }

    out.print(`Found ${backups.length} backup refs and ${forkPoints.length} fork point tags.`);

    const option = await prompts.selectCleanupOption();

    if (option === "keep") {
        out.print(chalk.dim("\nNothing changed."));
        return;
    }

    if (option === "delete-all" || option === "delete-tags-only") {
        out.print("\nDeleting fork point tags...");
        await forkPointManager.cleanup();
    }

    if (option === "delete-all") {
        out.print("Deleting backup refs...");
        await backupManager.cleanup();
    }

    // Clear state file if exists
    await stateManager.clear();

    out.print(chalk.green("\n✅ Cleanup complete!"));
}

/**
 * Restore a single branch from backup
 */
async function restoreSingleBranch(branch?: string): Promise<void> {
    const backups = await backupManager.listBackups();

    if (backups.length === 0) {
        out.print(chalk.red("No backup refs found."));
        process.exit(1);
    }

    const branchToRestore = branch || (await prompts.selectBranchToRestore(backups.map((b) => b.branch)));

    const backup = backups.find((b) => b.branch === branchToRestore);
    if (!backup) {
        out.print(chalk.red(`No backup found for branch: ${branchToRestore}`));
        process.exit(1);
    }

    out.print(`\nRestoring ${chalk.cyan(branchToRestore)} to ${chalk.dim(backup.sha.substring(0, 7))}...`);
    await backupManager.restoreBackup(branchToRestore);
    out.print(chalk.green(`\n✅ ${branchToRestore} restored!`));
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
    out.print(chalk.bold(`\n🔄 Rebasing ${state.parentBranch} onto ${state.targetBranch}...`));
    out.print(chalk.dim(`   git checkout ${state.parentBranch}`));
    out.print(chalk.dim(`   git rebase ${state.targetBranch}\n`));

    await git.checkout(state.parentBranch);
    const result = await git.rebase(state.targetBranch);

    if (!result.success) {
        const errorType = await git.diagnoseRebaseFailure();

        switch (errorType) {
            case "lock":
                out.print(chalk.red("\n✗ Git is locked (.git/index.lock exists)."));
                out.print(chalk.dim("   Another git process may be running."));
                out.print(chalk.dim("   Remove the lock file if no git process is active."));
                break;
            case "conflict":
                out.print(chalk.yellow("\n⚠️  Merge conflicts detected!"));
                out.print(chalk.dim("\n   To resolve:"));
                out.print(chalk.dim("   1. Fix all conflicts in your editor"));
                out.print(chalk.dim("   2. Stage resolved files: git add <file>"));
                out.print(chalk.dim("   3. Continue: git rebase --continue"));
                out.print(chalk.dim("   4. Repeat steps 1-3 until rebase completes"));
                out.print(chalk.dim("   5. Once git rebase is FULLY DONE, run:"));
                out.print(chalk.cyan("      tools git-rebase-multiple --continue"));
                out.print(chalk.dim("\n   Or abort everything: tools git-rebase-multiple --abort"));
                break;
            case "dirty":
                out.print(chalk.red("\n✗ Rebase failed - working tree is dirty."));
                out.print(chalk.dim("   Commit or stash your changes first."));
                break;
            default:
                out.print(chalk.red("\n✗ Rebase failed with unknown error."));
                out.print(chalk.dim("   Check the git output above for details."));
        }

        await stateManager.updatePhase("PARENT_REBASE");
        return false;
    }

    await stateManager.markCompleted(state.parentBranch);
    const commits = await git.countCommits(state.targetBranch, state.parentBranch);
    out.print(chalk.green(`\n✅ ${state.parentBranch} rebased successfully! (${commits} commits)`));

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
            out.print(chalk.red(`\n✗ No fork point found for ${child}. Skipping.`));
            continue;
        }

        await stateManager.setCurrentChild(child);

        out.print(chalk.bold(`\n🔄 Rebasing ${child} onto ${state.parentBranch}...`));
        out.print(chalk.dim(`   git checkout ${child}`));
        out.print(chalk.dim(`   git rebase --onto ${state.parentBranch} fork/${child}\n`));

        await git.checkout(child);
        const result = await git.rebaseOnto(state.parentBranch, `fork/${child}`);

        if (!result.success) {
            const errorType = await git.diagnoseRebaseFailure();

            switch (errorType) {
                case "lock":
                    out.print(chalk.red("\n✗ Git is locked (.git/index.lock exists)."));
                    out.print(chalk.dim("   Another git process may be running."));
                    out.print(chalk.dim("   Remove the lock file if no git process is active."));
                    break;
                case "conflict":
                    out.print(chalk.yellow("\n⚠️  Merge conflicts detected!"));
                    out.print(chalk.dim("\n   To resolve:"));
                    out.print(chalk.dim("   1. Fix all conflicts in your editor"));
                    out.print(chalk.dim("   2. Stage resolved files: git add <file>"));
                    out.print(chalk.dim("   3. Continue: git rebase --continue"));
                    out.print(chalk.dim("   4. Repeat steps 1-3 until rebase completes"));
                    out.print(chalk.dim("   5. Once git rebase is FULLY DONE, run:"));
                    out.print(chalk.cyan("      tools git-rebase-multiple --continue"));
                    out.print(chalk.dim("\n   Or abort everything: tools git-rebase-multiple --abort"));
                    break;
                case "dirty":
                    out.print(chalk.red("\n✗ Rebase failed - working tree is dirty."));
                    out.print(chalk.dim("   Commit or stash your changes first."));
                    break;
                default:
                    out.print(chalk.red("\n✗ Rebase failed with unknown error."));
                    out.print(chalk.dim("   Check the git output above for details."));
            }
            return false;
        }

        await stateManager.markCompleted(child);
        const commits = await git.countCommits(state.parentBranch, child);
        out.print(chalk.green(`✅ ${child} rebased successfully! (${commits} commits)`));

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

    out.print(chalk.bold("\n🧹 Cleanup\n"));

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

    out.print(chalk.bold("\n✅ Complete! Summary:\n"));
    for (const summary of summaries) {
        const status = summary.success ? chalk.green("✓") : chalk.red("✗");
        out.print(`   ${status} ${summary.branch}: ${summary.commitsApplied} commits`);
    }

    if (option === "keep") {
        out.print(chalk.dim(`\n   Backups available at refs/backup/grm/*`));
        out.print(chalk.dim(`   Run --cleanup when you're confident everything is correct.`));
    }

    // Clear state
    await stateManager.clear();

    // Return to original branch
    try {
        await git.checkout(state.originalBranch);
        out.print(chalk.dim(`\n   Returned to ${state.originalBranch}`));
    } catch {
        // Ignore
    }
}

/**
 * Run the interactive flow
 */
async function runInteractive(dryRun = false): Promise<void> {
    out.print(chalk.bold("\n📋 Git Rebase Multiple - Safe Branch Hierarchy Rebasing\n"));

    // Check preconditions
    const hasChanges = await git.hasUncommittedChanges();
    if (hasChanges) {
        out.print(chalk.red("✗ You have uncommitted changes. Please commit or stash them first."));
        process.exit(1);
    }

    const rebaseInProgress = await git.isRebaseInProgress();
    if (rebaseInProgress) {
        out.print(chalk.red("✗ A rebase is already in progress. Complete or abort it first."));
        out.print(chalk.dim("   Run: git rebase --continue OR git rebase --abort"));
        process.exit(1);
    }

    // Check for git lock file
    const isLocked = await git.isGitLocked();
    if (isLocked) {
        const repoRoot = await git.getRepoRoot();
        out.print(chalk.red("✗ Git repository is locked (.git/index.lock exists)."));
        out.print(chalk.dim("   This usually means another git process is running."));
        out.print(chalk.dim("   If you're sure no git process is running, delete the lock:"));
        out.print(chalk.dim(`   rm "${repoRoot}/.git/index.lock"`));
        process.exit(1);
    }

    // Check for existing state
    const existingState = await stateManager.load();
    if (existingState) {
        out.print(chalk.yellow("⚠️  An operation is already in progress."));
        out.print(chalk.dim("   Run: tools git-rebase-multiple --continue"));
        out.print(chalk.dim("   Or:  tools git-rebase-multiple --abort"));
        process.exit(1);
    }

    // Gather info
    const originalBranch = await git.getCurrentBranch();
    const parentBranch = await prompts.selectParentBranch();
    const targetBranch = await prompts.selectTargetBranch(parentBranch);

    // Find potential children
    out.print(chalk.dim("\nAnalyzing branch dependencies..."));
    const potentialChildren = await git.findPotentialChildren(parentBranch);
    const childBranches = await prompts.selectChildBranches(parentBranch, potentialChildren);

    // Check for divergence from remote tracking branch
    const tracking = await git.getTrackingBranch(parentBranch);
    if (tracking) {
        try {
            const divergence = await git.getDivergence(parentBranch, tracking);

            if (divergence.localOnly > 0 || divergence.remoteOnly > 0) {
                out.print(chalk.yellow(`\n⚠️  ${parentBranch} diverges from ${tracking}:`));

                if (divergence.localOnly > 0) {
                    out.print(chalk.dim(`\n   ${divergence.localOnly} unpushed local commit(s):`));
                    for (const commit of divergence.localCommits) {
                        out.print(chalk.dim(`     ${commit}`));
                    }
                    out.print(chalk.dim(`   (After rebase, you'll need 'git push --force')`));
                }

                if (divergence.remoteOnly > 0) {
                    out.print(chalk.red(`\n   ⚠️ ${divergence.remoteOnly} remote commit(s) NOT in local:`));
                    for (const commit of divergence.remoteCommits) {
                        out.print(chalk.red(`     ${commit}`));
                    }
                    out.print(chalk.red(`   (These commits may be LOST if you proceed!)`));
                }

                const proceed = await prompts.confirmDivergence();
                if (!proceed) {
                    out.print(chalk.yellow("\nOperation cancelled."));
                    out.print(chalk.dim("   Consider running 'git pull' to sync with remote first."));
                    process.exit(0);
                }
            }
        } catch {
            // Tracking branch might not exist on remote, continue
        }
    }

    // Check for divergence of TARGET branch from remote
    const targetTracking = await git.getTrackingBranch(targetBranch);
    if (targetTracking) {
        try {
            const targetDivergence = await git.getDivergence(targetBranch, targetTracking);

            if (targetDivergence.localOnly > 0 || targetDivergence.remoteOnly > 0) {
                out.print(chalk.yellow(`\n⚠️  Target branch ${targetBranch} diverges from ${targetTracking}:`));

                if (targetDivergence.localOnly > 0) {
                    out.print(chalk.yellow(`\n   ${targetDivergence.localOnly} local commit(s) NOT in remote:`));
                    for (const commit of targetDivergence.localCommits) {
                        out.print(chalk.yellow(`     ${commit}`));
                    }
                }

                if (targetDivergence.remoteOnly > 0) {
                    out.print(chalk.cyan(`\n   ${targetDivergence.remoteOnly} remote commit(s) NOT in local:`));
                    for (const commit of targetDivergence.remoteCommits) {
                        out.print(chalk.cyan(`     ${commit}`));
                    }
                }

                const action = await prompts.selectTargetDivergenceAction();

                switch (action) {
                    case "pull":
                        out.print(chalk.dim(`\n   Pulling ${targetBranch} from ${targetTracking}...`));
                        await git.pull(targetBranch);
                        out.print(chalk.green(`   ✓ ${targetBranch} updated from remote`));
                        break;
                    case "reset":
                        out.print(chalk.dim(`\n   Resetting ${targetBranch} to ${targetTracking}...`));
                        await git.resetHard(targetTracking);
                        out.print(chalk.green(`   ✓ ${targetBranch} reset to match remote`));
                        break;
                    case "skip":
                        out.print(chalk.dim("\n   Proceeding without syncing..."));
                        break;
                    case "cancel":
                        out.print(chalk.yellow("\nOperation cancelled."));
                        out.print(chalk.dim(`   Sync ${targetBranch} manually before rebasing.`));
                        process.exit(0);
                }
            }
        } catch {
            // Tracking branch might not exist on remote, continue
        }
    }

    const config: RebaseConfig = {
        parentBranch,
        targetBranch,
        childBranches,
    };

    // Generate and show plan
    const steps = generatePlanSteps(config);

    // Show commits that will be rebased
    out.print(chalk.bold("\n📌 Commits to be rebased:\n"));

    // Parent branch commits
    const mergeBase = await git.mergeBase(targetBranch, parentBranch);
    const parentCommits = await git.getCommitsBetween(mergeBase, parentBranch);

    out.print(`   ${chalk.cyan(parentBranch)} → ${chalk.cyan(targetBranch)}`);
    if (parentCommits.length > 0) {
        out.print(chalk.dim(`   ${parentCommits.length} commit(s) will be replayed:`));
        for (const commit of parentCommits.slice(0, 7)) {
            out.print(chalk.dim(`     ${commit}`));
        }
        if (parentCommits.length > 7) {
            out.print(chalk.dim(`     ... and ${parentCommits.length - 7} more`));
        }
    } else {
        out.print(chalk.dim(`   Already up to date (no commits to rebase)`));
    }

    // Child branches
    for (const child of childBranches) {
        const forkPoint = await git.mergeBase(parentBranch, child);
        const childCommits = await git.getCommitsBetween(forkPoint, child);

        out.print(`\n   ${chalk.cyan(child)} → new ${chalk.cyan(parentBranch)}`);
        out.print(chalk.dim(`   ${childCommits.length} commit(s) will be replayed:`));
        for (const commit of childCommits.slice(0, 5)) {
            out.print(chalk.dim(`     ${commit}`));
        }
        if (childCommits.length > 5) {
            out.print(chalk.dim(`     ... and ${childCommits.length - 5} more`));
        }
    }

    const confirmed = await prompts.confirmPlan(config, steps);

    if (!confirmed) {
        out.print(chalk.yellow("\nOperation cancelled."));
        process.exit(0);
    }

    if (dryRun) {
        out.print(chalk.cyan("\n[Dry run] No changes made."));
        process.exit(0);
    }

    // Step 1: Create backups
    out.print(chalk.bold("\n📦 Step 1: Creating backup refs...\n"));
    const branchesToBackup = [parentBranch, ...childBranches];
    const backups: Record<string, string> = {};

    for (const branch of branchesToBackup) {
        const backup = await backupManager.createBackup(branch);
        backups[branch] = backup.sha;
        out.print(`   ${chalk.green("✓")} ${branch} → ${chalk.dim(backup.ref)}`);
    }

    // Step 2: Save fork points
    const forkPoints: Record<string, string> = {};
    if (childBranches.length > 0) {
        out.print(chalk.bold("\n📍 Step 2: Saving fork points...\n"));
        for (const child of childBranches) {
            const info = await forkPointManager.save(parentBranch, child);
            forkPoints[child] = info.forkPointSha;
            out.print(
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
        out.print(chalk.red("✗ --parent and --target are required in non-interactive mode."));
        process.exit(1);
    }

    // Validate branches exist
    if (!(await git.branchExists(parent))) {
        out.print(chalk.red(`✗ Branch does not exist: ${parent}`));
        process.exit(1);
    }
    if (!(await git.branchExists(target))) {
        out.print(chalk.red(`✗ Branch does not exist: ${target}`));
        process.exit(1);
    }

    const childBranches = children ? children.split(",").map((c) => c.trim()) : [];
    for (const child of childBranches) {
        if (!(await git.branchExists(child))) {
            out.print(chalk.red(`✗ Branch does not exist: ${child}`));
            process.exit(1);
        }
    }

    // Run the same flow as interactive but with pre-defined values
    out.print(chalk.bold("\n📋 Git Rebase Multiple - Non-Interactive Mode\n"));
    out.print(`  Parent: ${chalk.cyan(parent)} → ${chalk.cyan(target)}`);
    out.print(`  Children: ${childBranches.join(", ") || "(none)"}\n`);

    // Check preconditions
    const hasChanges = await git.hasUncommittedChanges();
    if (hasChanges) {
        out.print(chalk.red("✗ You have uncommitted changes. Please commit or stash them first."));
        process.exit(1);
    }

    // Similar flow as interactive, but without prompts for branch selection
    // For brevity, reuse the interactive flow after setting up
    out.print(chalk.yellow("Non-interactive mode executes the same steps as interactive mode."));
    out.print(chalk.dim("Use --dry-run first to preview the plan.\n"));

    // For now, require interactive confirmation for safety
    out.print(chalk.red("Non-interactive mode without --dry-run is not yet implemented."));
    out.print(chalk.dim("Use interactive mode for full functionality."));
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
        .option("-?, --help-full", "Show detailed help message");

    await runTool(program, { tool: "git-rebase-multiple" });

    const options = program.opts<CLIOptions & { helpFull?: boolean }>();

    try {
        if (options.helpFull) {
            showHelpFull();
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
                out.print(chalk.yellow("\n🚫 Operation cancelled."));
                process.exit(0);
            }
            out.print(chalk.red(`\n✗ Error: ${error.message}`));
        } else {
            out.print(chalk.red(`\n✗ Error: ${error}`));
        }
        process.exit(1);
    }
}

main();
