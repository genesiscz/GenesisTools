import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Executor } from "@app/utils/cli";
import { isPromptCancelled } from "@app/utils/prompt-helpers.js";
import { handleReadmeFlag } from "@app/utils/readme";
import { confirm, input, number } from "@inquirer/prompts";
import chalk from "chalk";
import { Command } from "commander";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

// Simple logger that doesn't interfere with prompts
const logger = {
    info: (msg: string) => console.log(chalk.blue("ℹ"), msg),
    warn: (msg: string) => console.log(chalk.yellow("⚠"), msg),
    error: (msg: string) => console.log(chalk.red("✖"), msg),
    debug: (msg: string) => {
        if (process.env.DEBUG) {
            console.log(chalk.dim("🐛"), msg);
        }
    },
};

interface Options {
    commits?: number;
    helpFull?: boolean;
    force?: boolean;
}

interface CommitInfo {
    hash: string;
    shortHash: string;
    message: string;
    newMessage?: string;
}

function showHelpFull() {
    logger.info(`
Usage: tools git-rename-commits [--commits N] [--help]

Description:
  Interactively rename commit messages for the last N commits.
  You'll be prompted to provide a new message for each commit,
  then see a confirmation screen before the commits are rewritten.

Options:
  -c, --commits   Number of recent commits to rename (default: prompts if not provided)
  -f, --force     Skip safety check (not recommended - use only if commits are backed up)
  -?, --help-full Show this help message (Commander auto-generates --help)

Examples:
  tools git-rename-commits --commits 3
  tools git-rename-commits -c 5
`);
}

async function getCurrentRepoDir(): Promise<string> {
    const git = new Executor({ prefix: "git" });
    const { stdout, stderr, success } = await git.exec(["rev-parse", "--show-toplevel"]);

    if (!success) {
        throw new Error(`Not in a git repository: ${stderr.trim()}`);
    }

    return resolve(stdout.trim());
}

async function getCurrentBranch(repoDir: string): Promise<string> {
    const git = new Executor({ prefix: "git", cwd: repoDir });
    const { stdout, success } = await git.exec(["rev-parse", "--abbrev-ref", "HEAD"]);

    if (!success) {
        return "unknown";
    }

    return stdout.trim();
}

async function getCommits(
    repoDir: string,
    count: number,
    currentBranchOnly: boolean = true
): Promise<{ commits: CommitInfo[]; detectionMethod?: string; baseBranchName?: string }> {
    logger.debug(`⏳ Fetching last ${count} commits from ${repoDir}...`);

    const git = new Executor({ prefix: "git", cwd: repoDir });

    // Build git log command
    let gitArgs: string[] = [];
    let detectionMethod = "";
    let baseBranchName: string | undefined;

    if (currentBranchOnly) {
        // Only show commits that are unique to current branch (exclude base branch commits)
        // Strategy: Find the branch this was created from, then use its merge-base
        let baseRef = "";
        const currentBranch = await getCurrentBranch(repoDir);

        // Step 1: Use git merge-base --fork-point to find where branch diverged
        // This is more reliable than reflog parsing as it uses git's built-in fork detection
        // Strategy: Check all local branches, find the one with the most recent fork point

        // Get all local branches
        const { stdout: branchesOutput } = await git.exec(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);

        const allBranches = branchesOutput
            .trim()
            .split("\n")
            .filter((b) => b && b !== currentBranch);

        let sourceBranch: string | null = null;
        let bestForkPoint: string | null = null;
        let bestForkPointDate = 0;

        // Check each branch to find the one with the most recent fork point
        for (const branch of allBranches) {
            try {
                // Use --fork-point to find where current branch diverged from this branch
                const { stdout: forkPointHash, success: forkPointSuccess } = await git.exec([
                    "merge-base",
                    "--fork-point",
                    branch,
                    "HEAD",
                ]);

                if (forkPointSuccess && forkPointHash.trim()) {
                    // Get the commit date of the fork point to find the most recent one
                    const { stdout: dateStr } = await git.exec(["log", "-1", "--format=%ct", forkPointHash.trim()]);

                    const forkPointDate = parseInt(dateStr.trim(), 10) || 0;

                    // Use the branch with the most recent fork point
                    // (most recent = highest timestamp = most recent divergence)
                    if (forkPointDate > bestForkPointDate) {
                        sourceBranch = branch;
                        bestForkPoint = forkPointHash.trim();
                        bestForkPointDate = forkPointDate;
                    }
                }
            } catch {}
        }

        // If no fork point found with --fork-point, fall back to regular merge-base
        if (!sourceBranch) {
            // Try common base branches as fallback
            for (const branch of ["main", "master", "develop"]) {
                const { success } = await git.exec(["rev-parse", "--verify", branch]);

                if (success) {
                    const { stdout: mergeBase } = await git.exec(["merge-base", "HEAD", branch]);

                    if (mergeBase.trim()) {
                        sourceBranch = branch;
                        bestForkPoint = mergeBase.trim();
                        break;
                    }
                }
            }
        }

        // Step 2: Use the fork point we found
        if (sourceBranch && bestForkPoint) {
            baseRef = bestForkPoint;
            baseBranchName = sourceBranch;
            detectionMethod = "fork-point";
            logger.debug(`Found fork-point from branch ${sourceBranch}: ${baseRef.substring(0, 7)}`);
        } else if (sourceBranch) {
            // Fallback: calculate merge-base if fork-point wasn't available
            const { stdout: mergeBase, success: mergeBaseSuccess } = await git.exec([
                "merge-base",
                "HEAD",
                sourceBranch,
            ]);

            if (mergeBaseSuccess && mergeBase.trim()) {
                baseRef = mergeBase.trim();
                baseBranchName = sourceBranch;
                detectionMethod = "merge-base";
                logger.debug(`Found merge-base from source branch ${sourceBranch}: ${baseRef.substring(0, 7)}`);
            }
        }

        // Step 3: If no source branch found, try all local branches to find the closest ancestor
        if (!baseRef) {
            const { stdout: branchesOutput2 } = await git.exec([
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads/",
            ]);

            const branches = branchesOutput2
                .trim()
                .split("\n")
                .filter((b) => b && b !== currentBranch);

            // Find the branch with the most recent merge-base (closest ancestor)
            let bestBranch = "";
            let bestMergeBase = "";
            for (const branch of branches) {
                const { stdout: mergeBase, success: mergeBaseSuccess } = await git.exec(["merge-base", "HEAD", branch]);

                if (mergeBaseSuccess && mergeBase.trim()) {
                    const mergeBaseHash = mergeBase.trim();
                    // Check if this merge-base is more recent (closer to HEAD) than the current best
                    if (!bestMergeBase || mergeBaseHash !== bestMergeBase) {
                        // Check if this merge-base is an ancestor of the current best (meaning it's more recent)
                        const { success: isAncestor } = await git.exec([
                            "merge-base",
                            "--is-ancestor",
                            mergeBaseHash,
                            bestMergeBase || "HEAD",
                        ]);

                        // If merge-base is ancestor of bestMergeBase, it's older, so skip
                        // If bestMergeBase is empty or merge-base is not ancestor of bestMergeBase, use this one
                        if (!bestMergeBase || !isAncestor) {
                            bestMergeBase = mergeBaseHash;
                            bestBranch = branch;
                        }
                    }
                }
            }

            if (bestMergeBase) {
                baseRef = bestMergeBase;
                baseBranchName = bestBranch;
                detectionMethod = "closest local branch";
                logger.debug(`Found merge-base from closest branch ${bestBranch}: ${baseRef.substring(0, 7)}`);
            }
        }

        // Step 4: Fallback to common base branches
        if (!baseRef) {
            for (const branch of ["master", "main", "develop"]) {
                const { success } = await git.exec(["rev-parse", "--verify", branch]);

                if (success) {
                    const { stdout: mergeBase, success: mergeBaseSuccess } = await git.exec([
                        "merge-base",
                        "HEAD",
                        branch,
                    ]);

                    if (mergeBaseSuccess && mergeBase.trim()) {
                        baseRef = mergeBase.trim();
                        baseBranchName = branch;
                        detectionMethod = `common base branch (${branch})`;
                        logger.debug(`Found merge-base from ${branch}: ${baseRef.substring(0, 7)}`);
                        break;
                    }
                }
            }
        }

        if (baseRef) {
            // Show commits on HEAD that are not on the base branch
            gitArgs = ["log", `-n`, `${count}`, "--pretty=format:%H|%h|%s", "--no-decorate", "HEAD", `--not`, baseRef];
            logger.debug(`Using merge-base: ${baseRef.substring(0, 7)}`);
        } else {
            // Fallback: if no merge-base found, just show commits from HEAD
            // This happens when branch has no upstream or base branch doesn't exist
            gitArgs = ["log", `-n`, `${count}`, "--pretty=format:%H|%h|%s", "--no-decorate", "HEAD"];
            detectionMethod = "all commits from HEAD (no base found)";
            logger.debug("No merge-base found, showing all commits from HEAD");
        }
    } else {
        gitArgs = ["log", `-n`, `${count}`, "--pretty=format:%H|%h|%s", "--no-decorate"];
        detectionMethod = "all commits";
    }

    const { stdout, stderr, exitCode } = await git.exec(gitArgs);

    if (exitCode !== 0) {
        logger.debug(`Git command failed: git ${gitArgs.join(" ")}`);
        logger.debug(`Stderr: ${stderr.trim()}`);
        throw new Error(`Failed to get commits: ${stderr.trim()}`);
    }

    logger.debug(
        `Git command succeeded, got ${
            stdout
                .trim()
                .split("\n")
                .filter((l) => l.trim()).length
        } commits`
    );

    const lines = stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim());
    const commits: CommitInfo[] = [];

    for (const line of lines) {
        const parts = line.split("|");

        if (parts.length >= 3) {
            commits.push({
                hash: parts[0],
                shortHash: parts[1],
                message: parts.slice(2).join("|"), // In case message contains |
            });
        }
    }

    // Reverse to get oldest first (for rebase order)
    return {
        commits: commits.reverse(),
        detectionMethod,
        baseBranchName,
    };
}

function suggestCommitName(commit: CommitInfo, allCommits: CommitInfo[], defaultScope?: string | null): string {
    const message = commit.message.toLowerCase();

    // Find most common scope from all commits, or use provided defaultScope
    let mostCommonScope: string | undefined = defaultScope || undefined;

    if (!mostCommonScope) {
        const scopeCounts = new Map<string, number>();
        for (const c of allCommits) {
            const match = c.message.match(/^\w+\(([^)]+)\):/);

            if (match) {
                const scope = match[1].toLowerCase();
                scopeCounts.set(scope, (scopeCounts.get(scope) || 0) + 1);
            }
        }
        mostCommonScope = Array.from(scopeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    }

    // Type shortening map
    const typeMap: Record<string, string> = {
        refactor: "ref",
        feature: "feat",
        documentation: "docs",
    };

    // Check if already a conventional commit
    const conventionalMatch = commit.message.match(/^(\w+)(\(([^)]+)\))?:(.+)$/);

    if (conventionalMatch) {
        // Already conventional - shorten type and ensure scope if common scope exists
        const type = conventionalMatch[1].toLowerCase();
        const existingScope = conventionalMatch[3];
        const rest = conventionalMatch[4].trim();

        const shortType = typeMap[type] || type;

        // If no scope but we have a common scope, add it
        if (!existingScope && mostCommonScope) {
            return `${shortType}(${mostCommonScope}): ${rest}`;
        }

        // Just shorten the type
        return `${shortType}${existingScope ? `(${existingScope})` : ""}: ${rest}`;
    } else {
        // Not conventional - determine type and add scope
        let suggestedType = "feat";

        if (message.match(/\b(fix|fixes|fixed|bug|error|issue)\b/)) {
            suggestedType = "fix";
        } else if (message.match(/\b(refactor|refactoring|refactored|cleanup|clean|standardize)\b/)) {
            suggestedType = "ref";
        } else if (message.match(/\b(doc|docs|documentation|readme)\b/)) {
            suggestedType = "docs";
        } else if (message.match(/\b(test|tests|testing|spec)\b/)) {
            suggestedType = "test";
        } else if (message.match(/\b(style|format|formatting|lint)\b/)) {
            suggestedType = "style";
        } else if (message.match(/\b(perf|performance|optimize|optimization)\b/)) {
            suggestedType = "perf";
        } else if (message.match(/\b(chore|build|ci|deps|dependencies)\b/)) {
            suggestedType = "chore";
        }

        const shortType = typeMap[suggestedType] || suggestedType;

        // Add scope if we found a common one
        if (mostCommonScope) {
            return `${shortType}(${mostCommonScope}): ${commit.message}`;
        } else {
            return `${shortType}: ${commit.message}`;
        }
    }
}

async function promptForNewMessage(
    commit: CommitInfo,
    index: number,
    total: number,
    allCommits: CommitInfo[],
    defaultScope?: string | null
): Promise<string> {
    // Show current message clearly before the prompt
    const suggestion = suggestCommitName(commit, allCommits, defaultScope);
    console.log(chalk.dim(`\n  Current message: ${chalk.reset(commit.message)}`));

    if (suggestion !== commit.message) {
        console.log(chalk.dim(`  💡 Suggestion: ${chalk.green(suggestion)}`));
    }

    const newMessageRaw = await input({
        message: `[${index + 1}/${total}] Enter new message for commit ${chalk.cyan(commit.shortHash)}:`,
        default: suggestion,
        validate: (v) => (v?.trim().length ?? 0) > 0 || "Commit message cannot be empty",
    });

    let newMessage = newMessageRaw.trim();

    // Extract just the message part from suggestion (remove type prefix if present)
    // This handles cases where user types "feat(scope): <suggested>" and suggestion is "feat: message"
    // We want "feat(scope): message" not "feat(scope): feat: message"
    let suggestionMessage = suggestion;
    const suggestionMatch = suggestion.match(/^\w+(?:\([^)]+\))?:\s*(.+)$/);

    if (suggestionMatch) {
        suggestionMessage = suggestionMatch[1]; // Just the message part after "type: "
    }

    // Replace placeholders
    newMessage = newMessage.replace(/<suggested>/g, suggestionMessage);
    newMessage = newMessage.replace(/<original>/g, commit.message);

    return newMessage;
}

function showConfirmation(commits: CommitInfo[]): string {
    const lines: string[] = [];
    lines.push(chalk.bold("\n📋 Commit Message Changes:\n"));
    lines.push(chalk.dim("─".repeat(80)));

    for (const commit of commits) {
        lines.push(`\n${chalk.cyan(commit.shortHash)}:`);
        lines.push(`  ${chalk.red("OLD:")} ${commit.message}`);
        lines.push(`  ${chalk.green("NEW:")} ${commit.newMessage}`);
    }

    lines.push(chalk.dim(`\n${"─".repeat(80)}`));
    lines.push(chalk.bold("\n⚠️  This will rewrite git history. Make sure you haven't pushed these commits yet!\n"));

    return lines.join("\n");
}

async function checkAndCleanupLock(repoDir: string): Promise<void> {
    const lockFile = `${repoDir}/.git/index.lock`;
    try {
        const stat = await Bun.file(lockFile).exists();

        if (stat) {
            logger.warn("⚠️  Found stale git lock file, removing it...");
            await Bun.spawn({ cmd: ["rm", "-f", lockFile], cwd: repoDir }).exited;
            // Wait a bit for filesystem to sync
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    } catch (e) {
        // Lock file doesn't exist or can't be checked, that's fine
        logger.debug(`Lock file check: ${e}`);
    }
}

async function performRebase(repoDir: string, commits: CommitInfo[]): Promise<void> {
    const git = new Executor({ prefix: "git", cwd: repoDir });
    const count = commits.length;
    logger.info(`🔄 Starting interactive rebase for ${count} commit(s)...`);

    // Check and cleanup any stale lock files before starting
    await checkAndCleanupLock(repoDir);

    // Create message queue file - store each message in a separate numbered file
    // This is simpler and more reliable than trying to parse delimiters
    const messagesDir = `/tmp/genesis-tools-msgs-${Date.now()}`;
    await Bun.spawn({ cmd: ["mkdir", "-p", messagesDir] }).exited;

    for (let i = 0; i < commits.length; i++) {
        const msgFile = `${messagesDir}/${i}.txt`;
        await Bun.write(msgFile, commits[i].newMessage || "");
    }

    // Create index file to track which commit we're currently editing
    const indexFilePath = `/tmp/genesis-tools-index-${Date.now()}.txt`;
    await Bun.write(indexFilePath, "0");

    // Create a simple editor script that reads messages from numbered files
    const editorScriptPath = `/tmp/genesis-tools-editor-${Date.now()}.sh`;
    // Use string concatenation to avoid template literal evaluation of ${idx}
    // Make the script more robust with error handling and atomic operations
    const editorScript =
        `#!/bin/bash
set -euo pipefail
# Use a lock file to prevent race conditions
lockfile="${indexFilePath}.lock"
# Wait for lock (max 5 seconds)
for i in {1..50}; do
    if ! [ -f "$lockfile" ]; then
        break
    fi
    sleep 0.1
done
touch "$lockfile"
trap "rm -f '$lockfile'" EXIT

idx=$(cat "${indexFilePath}" 2>/dev/null | tr -d '[:space:]' || echo 0)
msgfile="${messagesDir}/` +
        "${idx}" +
        `.txt"
if [ -f "$msgfile" ]; then
    cat "$msgfile" > "$1"
    echo $((idx + 1)) > "${indexFilePath}"
else
    # If message file doesn't exist, use original message (fallback)
    echo "Warning: Message file $msgfile not found" >&2
fi
`;
    await Bun.write(editorScriptPath, editorScript);
    await Bun.spawn({ cmd: ["chmod", "+x", editorScriptPath] }).exited;

    // Sequence editor: change 'pick' to 'reword' using sed
    // Git passes the rebase-todo file path as $1
    const sequenceEditorCmd = `sed -i '' 's/^pick /reword /' "$1"`;

    // Set up environment for rebase
    const env = {
        ...process.env,
        GIT_SEQUENCE_EDITOR: `sh -c ${JSON.stringify(sequenceEditorCmd)} _`,
        GIT_EDITOR: editorScriptPath,
    };

    logger.info("🔄 Executing git rebase...");

    const { exitCode } = await git.execInteractive(["rebase", "-i", `HEAD~${count}`], { env });

    // Cleanup temporary files
    try {
        await Bun.spawn({
            cmd: ["rm", "-rf", messagesDir, indexFilePath, editorScriptPath],
        }).exited;
    } catch (e) {
        // Ignore cleanup errors
        logger.debug(`Cleanup warning: ${e}`);
    }

    // Cleanup lock file if rebase failed
    if (exitCode !== 0) {
        await checkAndCleanupLock(repoDir);

        // Check if we're in a rebase state by checking for rebase-merge directory
        const rebaseMergeDir = `${repoDir}/.git/rebase-merge`;
        const rebaseApplyDir = `${repoDir}/.git/rebase-apply`;
        const isInRebase =
            (existsSync(rebaseMergeDir) && statSync(rebaseMergeDir).isDirectory()) ||
            (existsSync(rebaseApplyDir) && statSync(rebaseApplyDir).isDirectory());

        if (isInRebase) {
            // We're still in a rebase - check status
            const { stdout: statusOutput } = await git.exec(["status", "--short"]);

            if (statusOutput.trim()) {
                throw new Error(
                    `Git rebase failed with exit code ${exitCode}. The rebase is still in progress.\n` +
                        `You may need to:\n` +
                        `  1. Resolve any conflicts manually\n` +
                        `  2. Run: git rebase --continue\n` +
                        `  3. Or abort with: git rebase --abort\n` +
                        `\nCurrent status:\n${statusOutput}`
                );
            } else {
                // No conflicts, might just need to continue
                logger.warn("⚠️  Rebasing may have been interrupted. Try running: git rebase --continue");
                throw new Error(
                    `Git rebase failed with exit code ${exitCode}. The rebase may have been interrupted.\n` +
                        `Try running: git rebase --continue`
                );
            }
        } else {
            // Not in rebase state anymore
            throw new Error(
                `Git rebase failed with exit code ${exitCode}. The rebase may have been aborted or there may be conflicts.`
            );
        }
    }

    logger.info("✅ Commits successfully renamed!");

    // Verify that rebase didn't change any file contents (only commit messages)
    await verifyRebaseIntegrity(repoDir);
}

async function verifyRebaseIntegrity(repoDir: string): Promise<void> {
    logger.info("🔍 Verifying rebase integrity (checking for file differences)...");

    const git = new Executor({ prefix: "git", cwd: repoDir });

    // Get current branch
    const currentBranch = await getCurrentBranch(repoDir);

    // Try to find the upstream/remote branch
    let upstreamBranch: string | null = null;
    try {
        const { stdout: upstreamOutput, success: upstreamSuccess } = await git.exec([
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ]);

        if (upstreamSuccess && upstreamOutput.trim()) {
            upstreamBranch = upstreamOutput.trim();
        }
    } catch {
        // No upstream configured, try to find remote branch manually
    }

    // If no upstream found, try common remote branch names
    if (!upstreamBranch) {
        const remotes = ["origin", "upstream"];
        for (const remote of remotes) {
            const remoteBranch = `${remote}/${currentBranch}`;
            const { success } = await git.exec(["rev-parse", "--verify", remoteBranch]);

            if (success) {
                upstreamBranch = remoteBranch;
                break;
            }
        }
    }

    if (!upstreamBranch) {
        logger.warn("⚠️  Could not find upstream/remote branch to verify against. Skipping integrity check.");
        return;
    }

    // Check for file differences
    const { stdout: diffOutput, exitCode: diffExitCode } = await git.exec([
        "diff",
        upstreamBranch,
        "HEAD",
        "--name-only",
    ]);

    if (diffExitCode !== 0) {
        logger.warn(`⚠️  Could not compare with ${upstreamBranch}. Skipping integrity check.`);
        return;
    }

    const changedFiles = diffOutput
        .trim()
        .split("\n")
        .filter((line) => line.trim());

    if (changedFiles.length === 0) {
        logger.info(`✅ Integrity check passed: No file differences between ${upstreamBranch} and HEAD`);
        logger.info("   (Only commit messages were changed, as expected)");
    } else {
        logger.warn(`⚠️  Integrity check warning: Found ${changedFiles.length} file(s) with differences:`);
        changedFiles.slice(0, 10).forEach((file) => {
            logger.warn(`   - ${file}`);
        });

        if (changedFiles.length > 10) {
            logger.warn(`   ... and ${changedFiles.length - 10} more file(s)`);
        }

        logger.warn("   This might indicate that the rebase changed file contents unexpectedly.");
    }
}

async function checkCommitsArePushed(repoDir: string, currentBranch: string): Promise<boolean> {
    logger.info("🔍 Checking if current commits are pushed to origin...");

    const git = new Executor({ prefix: "git", cwd: repoDir });

    // Get current HEAD commit hash
    const { stdout: headHash } = await git.exec(["rev-parse", "HEAD"]);

    if (!headHash.trim()) {
        logger.warn("⚠️  Could not determine current HEAD commit.");
        return false;
    }

    // Try to find upstream/remote branch
    let upstreamBranch: string | null = null;
    try {
        const { stdout: upstreamOutput, success: upstreamSuccess } = await git.exec([
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ]);

        if (upstreamSuccess && upstreamOutput.trim()) {
            upstreamBranch = upstreamOutput.trim();
        }
    } catch {
        // No upstream configured
    }

    // If no upstream found, try common remote branch names
    if (!upstreamBranch) {
        const remotes = ["origin", "upstream"];
        for (const remote of remotes) {
            const remoteBranch = `${remote}/${currentBranch}`;
            const { success } = await git.exec(["rev-parse", "--verify", remoteBranch]);

            if (success) {
                upstreamBranch = remoteBranch;
                break;
            }
        }
    }

    if (!upstreamBranch) {
        logger.warn("⚠️  Could not find upstream/remote branch.");
        logger.warn("   This might mean commits are not pushed yet.");
        return false;
    }

    // Get remote HEAD hash
    const { stdout: remoteHeadHash } = await git.exec(["rev-parse", upstreamBranch]);

    if (headHash.trim() === remoteHeadHash.trim()) {
        // HEAD matches remote exactly - safe to proceed
        logger.info(`✅ Current commit matches ${upstreamBranch}`);
        return true;
    }

    // Check if HEAD is an ancestor of remote (meaning remote has all our commits)
    const { success: isAncestor } = await git.exec(["merge-base", "--is-ancestor", headHash.trim(), upstreamBranch]);

    if (isAncestor) {
        // HEAD is an ancestor of upstream, meaning all commits are pushed
        logger.info(`✅ Current commit is pushed to ${upstreamBranch}`);
        return true;
    }

    // Check if remote is ahead (local is behind) - this is okay, remote has our commits
    const { stdout: remoteAheadCountStr } = await git.exec([
        "rev-list",
        "--count",
        `${headHash.trim()}..${upstreamBranch}`,
    ]);
    const remoteAheadCount = parseInt(remoteAheadCountStr.trim() || "0", 10);

    if (remoteAheadCount > 0) {
        // Remote is ahead - check if our commits are still on remote
        const { stdout: localAheadCountStr } = await git.exec([
            "rev-list",
            "--count",
            `${remoteHeadHash.trim()}..${headHash.trim()}`,
        ]);
        const localAheadCount = parseInt(localAheadCountStr.trim() || "0", 10);

        if (localAheadCount === 0) {
            // Local has no commits that remote doesn't have - safe (remote is just ahead)
            logger.info(
                `✅ All local commits exist on ${upstreamBranch} (remote is ${remoteAheadCount} commit(s) ahead)`
            );
            return true;
        } else {
            // Local has commits not on remote - check if file contents match (might be rebase)
            const { stdout: fileDiffOutput } = await git.exec([
                "diff",
                "--name-only",
                remoteHeadHash.trim(),
                headHash.trim(),
            ]);

            const changedFiles = fileDiffOutput
                .trim()
                .split("\n")
                .filter((line) => line.trim());

            if (changedFiles.length === 0) {
                // File contents match - this is likely a rebase, safe to proceed
                logger.info(`✅ Branches have diverged but file contents match (likely after a rebase)`);
                logger.info(
                    `   Local is ${localAheadCount} commit(s) ahead, remote is ${remoteAheadCount} commit(s) ahead`
                );
                return true;
            } else {
                // File contents differ - commits not pushed
                logger.warn(`⚠️  Local has ${localAheadCount} commit(s) not on ${upstreamBranch}`);
                logger.warn(`   Found ${changedFiles.length} file change(s) - commits may not be backed up`);
                return false;
            }
        }
    }

    // Local is ahead or diverged - check if file contents are the same
    // (This handles the case where a rebase changed commit hashes but not file contents)
    const { stdout: localAheadCountStr } = await git.exec([
        "rev-list",
        "--count",
        `${remoteHeadHash.trim()}..${headHash.trim()}`,
    ]);
    const localAheadCount = parseInt(localAheadCountStr.trim() || "0", 10);

    if (localAheadCount > 0) {
        // Check if file contents are the same (might be a rebase)
        const { stdout: fileDiffOutput } = await git.exec([
            "diff",
            "--name-only",
            remoteHeadHash.trim(),
            headHash.trim(),
        ]);

        const changedFiles = fileDiffOutput
            .trim()
            .split("\n")
            .filter((line) => line.trim());

        if (changedFiles.length === 0) {
            // File contents are the same - this is likely a rebase, safe to proceed
            logger.info(`✅ Branches have diverged but file contents match (likely after a rebase)`);
            logger.info(
                `   Local is ${localAheadCount} commit(s) ahead, remote is ${remoteAheadCount} commit(s) ahead`
            );
            return true;
        } else {
            // File contents differ - commits not pushed
            logger.warn(`⚠️  Current commit (${headHash.trim().substring(0, 7)}) is not pushed to ${upstreamBranch}`);
            logger.warn(`   Local is ${localAheadCount} commit(s) ahead with ${changedFiles.length} file change(s).`);
            return false;
        }
    }

    // Branches have diverged but local is not ahead - check file contents
    const { stdout: fileDiffOutput } = await git.exec(["diff", "--name-only", remoteHeadHash.trim(), headHash.trim()]);

    const changedFiles = fileDiffOutput
        .trim()
        .split("\n")
        .filter((line) => line.trim());

    if (changedFiles.length === 0) {
        // File contents match - safe (likely a rebase)
        logger.info(`✅ Branches have diverged but file contents match (likely after a rebase)`);
        return true;
    } else {
        logger.warn(`⚠️  Local branch has diverged from ${upstreamBranch} with ${changedFiles.length} file change(s)`);
        return false;
    }
}

async function main() {
    const program = new Command()
        .name("git-rename-commits")
        .description("Interactively rename git commits")
        .option("-c, --commits <n>", "Number of commits to rename", (value: string) => parseInt(value, 10))
        .option("-f, --force", "Force: skip safety check (not recommended - use only if commits are backed up)")
        .option("-?, --help-full", "Show detailed help message")
        .parse();

    const opts = program.opts<Options>();

    if (opts.helpFull) {
        showHelpFull();
        process.exit(0);
    }

    try {
        // Get repository directory
        const repoDir = await getCurrentRepoDir();
        const currentBranch = await getCurrentBranch(repoDir);
        const currentDir = process.cwd();

        // Show current context
        console.log(chalk.bold("\n📋 Current Context:"));
        console.log(`  Branch: ${chalk.cyan(currentBranch)}`);
        console.log(`  Directory: ${chalk.cyan(currentDir)}`);
        console.log(`  Repository: ${chalk.cyan(repoDir)}\n`);

        // Safety check: ensure commits are pushed before rewriting
        if (!opts.force) {
            const commitsArePushed = await checkCommitsArePushed(repoDir, currentBranch);

            if (!commitsArePushed) {
                logger.error("\n✖ Safety check failed: Current commits are not pushed to origin.");
                logger.error("   Rewriting unpushed commits can be dangerous if something goes wrong.");
                logger.error("   Please push your commits first as a backup:");
                logger.error(`   ${chalk.cyan(`git push origin ${currentBranch}`)}`);
                logger.error("\n   If you're sure you want to proceed anyway, use:");
                logger.error(`   ${chalk.cyan(`tools git-rename-commits --force`)}`);
                process.exit(1);
            }
        } else {
            logger.warn("⚠️  --force flag used: Skipping safety check.");
            logger.warn("   Proceeding without verifying commits are pushed.");
        }

        // Get number of commits
        let commitCount = opts.commits;

        if (!commitCount) {
            // Show last 50 commits numbered so user can see which ones will be renamed
            // Use currentBranchOnly=true to only show commits on current branch
            logger.info("📋 Fetching last 50 commits from current branch...");
            const recentCommitsResult = await getCommits(repoDir, 50, true);

            if (recentCommitsResult.commits.length === 0) {
                logger.warn("ℹ No commits found.");
                process.exit(0);
            }

            // Reverse to show newest first (getCommits returns oldest first for rebase)
            const recentCommits = [...recentCommitsResult.commits].reverse();

            // Show detection info
            if (recentCommitsResult.detectionMethod && recentCommitsResult.baseBranchName) {
                console.log(
                    chalk.dim(
                        `\n📍 Base branch detection: ${recentCommitsResult.detectionMethod} (${chalk.cyan(
                            recentCommitsResult.baseBranchName
                        )})`
                    )
                );
                console.log(chalk.dim(`   Showing ${recentCommits.length} commit(s) unique to current branch\n`));
            }

            console.log(chalk.bold("\n📝 Recent commits (showing last 50, newest first):\n"));
            recentCommits.forEach((commit, index) => {
                console.log(
                    chalk.dim(`${String(index + 1).padStart(2)}.`) +
                        ` ${chalk.cyan(commit.shortHash)} - ${commit.message}`
                );
            });
            console.log();

            const maxCommits = recentCommits.length;
            commitCount = await number({
                message: `How many commits do you want to rename? (1-${maxCommits})`,
                min: 1,
                max: maxCommits,
                default: 1,
                validate: (v) =>
                    (v !== undefined && v >= 1 && v <= maxCommits) || `Enter a number between 1 and ${maxCommits}`,
            });
        }

        const numCommits = Number(commitCount);

        if (!Number.isInteger(numCommits) || numCommits < 1) {
            logger.error("✖ Error: Number of commits must be a positive integer.");
            showHelpFull();
            process.exit(1);
        }

        // Get commits - use currentBranchOnly to only show commits on current branch
        logger.info(`📋 Fetching last ${numCommits} commit(s) from current branch...`);
        const commitsResult = await getCommits(repoDir, numCommits, true);
        const commits = commitsResult.commits;

        if (commits.length === 0) {
            logger.warn("ℹ No commits found.");
            process.exit(0);
        }

        // Show detection info
        if (commitsResult.detectionMethod && commitsResult.baseBranchName) {
            console.log(
                chalk.dim(
                    `\n📍 Base branch: ${chalk.cyan(commitsResult.baseBranchName)} (detected via ${
                        commitsResult.detectionMethod
                    })`
                )
            );
            console.log(chalk.dim(`   Showing ${commits.length} commit(s) unique to current branch\n`));
        }

        logger.info(`📝 Found ${commits.length} commit(s). Let's rename them:`);
        console.log(chalk.dim("\n💡 Tip: You can use placeholders in your commit messages:"));
        console.log(chalk.dim("   <suggested> - will be replaced with the suggested commit message"));
        console.log(chalk.dim("   <original>  - will be replaced with the original commit message"));
        console.log(chalk.dim('   Example: "feat(vouchers): <suggested>" or "refactor: <original>"\n'));

        // Check if we can determine a scope from existing commits
        let defaultScope: string | null = null;
        const scopeCounts = new Map<string, number>();
        for (const c of commits) {
            const match = c.message.match(/^\w+\(([^)]+)\):/);

            if (match) {
                const scope = match[1].toLowerCase();
                scopeCounts.set(scope, (scopeCounts.get(scope) || 0) + 1);
            }
        }
        const mostCommonScope = Array.from(scopeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];

        // If no scope found in commits, ask user for it
        if (!mostCommonScope) {
            const scopeInput = await input({
                message: "What scope should be used for commit suggestions? (e.g., 'vouchers', 'invoices', 'auth'):",
                default: "",
            });

            defaultScope = scopeInput.trim() || null;
        } else {
            defaultScope = mostCommonScope;
        }

        // Prompt for new messages (oldest first, as they appear in rebase)
        for (let i = 0; i < commits.length; i++) {
            const newMessage = await promptForNewMessage(commits[i], i, commits.length, commits, defaultScope);
            commits[i].newMessage = newMessage;
        }

        // Show confirmation
        console.log(showConfirmation(commits));

        const confirmed = await confirm({
            message: "Do you want to proceed with renaming these commits?",
            default: true,
        });

        if (!confirmed) {
            logger.info("\n🚫 Operation cancelled by user.");
            process.exit(0);
        }

        // Perform rebase
        await performRebase(repoDir, commits);

        logger.info("\n✨ All done! Your commits have been renamed.");
    } catch (error: unknown) {
        if (isPromptCancelled(error)) {
            logger.info("\n🚫 Operation cancelled by user.");
            process.exit(0);
        }

        const err = error as Error;
        logger.error(`\n✖ Error: ${err.message}`);

        if (err.stack) {
            logger.debug(err.stack);
        }

        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});
