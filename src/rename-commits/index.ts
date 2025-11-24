import minimist from "minimist";
import Enquirer from "enquirer";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import chalk from "chalk";

// Simple logger that doesn't interfere with prompts
const logger = {
    info: (msg: string) => console.log(chalk.blue("ℹ"), msg),
    warn: (msg: string) => console.log(chalk.yellow("⚠"), msg),
    error: (msg: string) => console.log(chalk.red("✖"), msg),
    debug: (msg: string) => {
        if (process.env.DEBUG) console.log(chalk.dim("🐛"), msg);
    },
};

interface Options {
    commits?: number;
    help?: boolean;
}

interface Args extends Options {
    _: string[];
    force?: boolean;
}

interface CommitInfo {
    hash: string;
    shortHash: string;
    message: string;
    newMessage?: string;
}

const prompter = new Enquirer();

function showHelp() {
    logger.info(`
Usage: tools rename-commits [--commits N] [--help]

Description:
  Interactively rename commit messages for the last N commits.
  You'll be prompted to provide a new message for each commit,
  then see a confirmation screen before the commits are rewritten.

Options:
  -c, --commits   Number of recent commits to rename (default: prompts if not provided)
  -f, --force     Skip safety check (not recommended - use only if commits are backed up)
  -h, --help      Show this help message

Examples:
  tools rename-commits --commits 3
  tools rename-commits -c 5
`);
}

async function getCurrentRepoDir(): Promise<string> {
    const proc = Bun.spawn({
        cmd: ["git", "rev-parse", "--show-toplevel"],
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        throw new Error(`Not in a git repository: ${stderr.trim()}`);
    }

    return resolve(stdout.trim());
}

async function getCurrentBranch(repoDir: string): Promise<string> {
    const proc = Bun.spawn({
        cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
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

    // Build git log command
    let gitArgs: string[] = [];
    let detectionMethod = "";
    let baseBranchName: string | undefined = undefined;

    if (currentBranchOnly) {
        // Only show commits that are unique to current branch (exclude base branch commits)
        // Strategy: Find the branch this was created from, then use its merge-base
        let baseRef = "";
        const currentBranch = await getCurrentBranch(repoDir);

        // Step 1: Try to find the branch this was created from using reflog
        const reflogProc = Bun.spawn({
            cmd: ["git", "reflog", "show", "--all"],
            cwd: repoDir,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const reflogOutput = await new Response(reflogProc.stdout).text();
        await reflogProc.exited;

        // Look for "checkout: moving from <branch> to <current-branch>"
        // Trace back through branch creation history to find the original base
        const reflogLines = reflogOutput.split("\n");
        let sourceBranch = null;
        let candidateBranches: string[] = [];

        // First, find branches that were checked out to create the current branch
        for (const line of reflogLines) {
            const match = line.match(/checkout: moving from ([^\s]+) to (.+)/);
            if (match && match[2] === currentBranch) {
                candidateBranches.push(match[1]);
            }
        }

        // If we found candidates, trace back through claude/* branches to find the original base
        // This handles cases where: feat/fixes -> claude/branch1 -> claude/branch2 (current)
        if (candidateBranches.length > 0) {
            // Start with the most recent candidate
            let branchToCheck = candidateBranches[0];
            const checkedBranches = new Set<string>([currentBranch]);
            let maxDepth = 10; // Prevent infinite loops

            while (branchToCheck && maxDepth > 0) {
                if (checkedBranches.has(branchToCheck)) {
                    break; // Avoid cycles
                }
                checkedBranches.add(branchToCheck);

                // If this is a feat/* branch, use it as the source
                if (/^(feat|feature)\//.test(branchToCheck)) {
                    sourceBranch = branchToCheck;
                    break;
                }

                // If this is not a claude/* branch, use it as source (might be main/master/etc)
                if (!/^claude\//.test(branchToCheck)) {
                    sourceBranch = branchToCheck;
                    break;
                }

                // Otherwise, trace back to find what this claude/* branch was created from
                // Collect all parents, prioritizing feat/* branches
                let parentBranch = null;
                const allParents: string[] = [];
                for (const line of reflogLines) {
                    const match = line.match(/checkout: moving from ([^\s]+) to (.+)/);
                    if (match && match[2] === branchToCheck) {
                        allParents.push(match[1]);
                    }
                }

                // Prioritize feat/* branches, then other non-claude branches, then claude branches
                const featParents = allParents.filter((p) => /^(feat|feature)\//.test(p));
                const nonClaudeParents = allParents.filter(
                    (p) => !/^claude\//.test(p) && p.length < 40 && !/^[0-9a-f]{40}$/i.test(p)
                );
                const claudeParents = allParents.filter((p) => /^claude\//.test(p));

                if (featParents.length > 0) {
                    parentBranch = featParents[0]; // Use first feat/* branch found
                } else if (nonClaudeParents.length > 0) {
                    parentBranch = nonClaudeParents[0]; // Use first non-claude branch
                } else if (claudeParents.length > 0) {
                    parentBranch = claudeParents[0]; // Fallback to claude branch
                } else if (allParents.length > 0) {
                    // Last resort: use first parent (might be a commit hash)
                    parentBranch = allParents[0];
                }

                // If we found a commit hash, try to find the branch it's on
                if (parentBranch && parentBranch.length === 40) {
                    // Try to find what branch this commit is on
                    const branchForCommitProc = Bun.spawn({
                        cmd: ["git", "branch", "--contains", parentBranch, "--format=%(refname:short)"],
                        cwd: repoDir,
                        stdio: ["ignore", "pipe", "pipe"],
                    });
                    const branchForCommit = (await new Response(branchForCommitProc.stdout).text())
                        .trim()
                        .split("\n")[0];
                    await branchForCommitProc.exited;

                    if (branchForCommit && branchForCommit !== currentBranch) {
                        parentBranch = branchForCommit;
                    } else {
                        // Look for checkout entries that might show the branch this commit was on
                        for (const line of reflogLines) {
                            const match = line.match(/checkout: moving from ([^\s]+) to (.+)/);
                            if (
                                match &&
                                match[1] === parentBranch &&
                                /^(feat|feature|main|master|develop)\//.test(match[2])
                            ) {
                                parentBranch = match[2];
                                break;
                            }
                        }
                    }
                }

                if (!parentBranch || parentBranch.length === 40) {
                    // No valid parent branch found, use current branch as source
                    sourceBranch = branchToCheck;
                    break;
                }

                branchToCheck = parentBranch;
                maxDepth--;
            }

            // If we didn't find a feat/* branch but have candidates, use the first non-claude one
            if (!sourceBranch && candidateBranches.length > 0) {
                const nonClaudeBranches = candidateBranches.filter((b) => !/^claude\//.test(b));
                if (nonClaudeBranches.length > 0) {
                    sourceBranch = nonClaudeBranches[0];
                } else {
                    // Fallback to first candidate
                    sourceBranch = candidateBranches[0];
                }
            }
        }

        // Step 2: If found, try to use that branch's merge-base
        if (sourceBranch && sourceBranch !== currentBranch) {
            const checkProc = Bun.spawn({
                cmd: ["git", "rev-parse", "--verify", sourceBranch],
                cwd: repoDir,
                stdio: ["ignore", "pipe", "pipe"],
            });
            const checkExitCode = await checkProc.exited;
            if (checkExitCode === 0) {
                const mergeBaseProc = Bun.spawn({
                    cmd: ["git", "merge-base", "HEAD", sourceBranch],
                    cwd: repoDir,
                    stdio: ["ignore", "pipe", "pipe"],
                });
                const [mergeBase, mergeBaseExitCode] = await Promise.all([
                    new Response(mergeBaseProc.stdout).text(),
                    mergeBaseProc.exited,
                ]);
                if (mergeBaseExitCode === 0 && mergeBase.trim()) {
                    baseRef = mergeBase.trim();
                    baseBranchName = sourceBranch;
                    detectionMethod = "reflog (feat/* branch)";
                    logger.debug(`Found merge-base from source branch ${sourceBranch}: ${baseRef.substring(0, 7)}`);
                }
            }
        }

        // Step 3: If no source branch found, try all local branches to find the closest ancestor
        if (!baseRef) {
            const branchesProc = Bun.spawn({
                cmd: ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
                cwd: repoDir,
                stdio: ["ignore", "pipe", "pipe"],
            });
            const branchesOutput = await new Response(branchesProc.stdout).text();
            await branchesProc.exited;

            const branches = branchesOutput
                .trim()
                .split("\n")
                .filter((b) => b && b !== currentBranch);

            // Find the branch with the most recent merge-base (closest ancestor)
            let bestBranch = "";
            let bestMergeBase = "";
            for (const branch of branches) {
                const mergeBaseProc = Bun.spawn({
                    cmd: ["git", "merge-base", "HEAD", branch],
                    cwd: repoDir,
                    stdio: ["ignore", "pipe", "pipe"],
                });
                const [mergeBase, mergeBaseExitCode] = await Promise.all([
                    new Response(mergeBaseProc.stdout).text(),
                    mergeBaseProc.exited,
                ]);
                if (mergeBaseExitCode === 0 && mergeBase.trim()) {
                    const mergeBaseHash = mergeBase.trim();
                    // Check if this merge-base is more recent (closer to HEAD) than the current best
                    if (!bestMergeBase || mergeBaseHash !== bestMergeBase) {
                        // Check if this merge-base is an ancestor of the current best (meaning it's more recent)
                        const compareProc = Bun.spawn({
                            cmd: ["git", "merge-base", "--is-ancestor", mergeBaseHash, bestMergeBase || "HEAD"],
                            cwd: repoDir,
                            stdio: ["ignore", "pipe", "pipe"],
                        });
                        const compareExitCode = await compareProc.exited;
                        // If merge-base is ancestor of bestMergeBase, it's older, so skip
                        // If bestMergeBase is empty or merge-base is not ancestor of bestMergeBase, use this one
                        if (!bestMergeBase || compareExitCode !== 0) {
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
                const checkProc = Bun.spawn({
                    cmd: ["git", "rev-parse", "--verify", branch],
                    cwd: repoDir,
                    stdio: ["ignore", "pipe", "pipe"],
                });
                const checkExitCode = await checkProc.exited;
                if (checkExitCode === 0) {
                    const mergeBaseProc = Bun.spawn({
                        cmd: ["git", "merge-base", "HEAD", branch],
                        cwd: repoDir,
                        stdio: ["ignore", "pipe", "pipe"],
                    });
                    const [mergeBase, mergeBaseExitCode] = await Promise.all([
                        new Response(mergeBaseProc.stdout).text(),
                        mergeBaseProc.exited,
                    ]);
                    if (mergeBaseExitCode === 0 && mergeBase.trim()) {
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

    const proc = Bun.spawn({
        cmd: ["git", ...gitArgs],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

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

function suggestCommitName(commit: CommitInfo, allCommits: CommitInfo[]): string {
    const message = commit.message.toLowerCase();

    // Find most common scope from all commits
    const scopeCounts = new Map<string, number>();
    for (const c of allCommits) {
        const match = c.message.match(/^\w+\(([^)]+)\):/);
        if (match) {
            const scope = match[1].toLowerCase();
            scopeCounts.set(scope, (scopeCounts.get(scope) || 0) + 1);
        }
    }
    const mostCommonScope = Array.from(scopeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];

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
    allCommits: CommitInfo[]
): Promise<string> {
    try {
        // Show current message clearly before the prompt
        const suggestion = suggestCommitName(commit, allCommits);
        console.log(chalk.dim(`\n  Current message: ${chalk.reset(commit.message)}`));
        if (suggestion !== commit.message) {
            console.log(chalk.dim(`  💡 Suggestion: ${chalk.green(suggestion)}`));
        }

        const response = (await prompter.prompt({
            type: "input",
            name: "newMessage",
            message: `[${index + 1}/${total}] Enter new message for commit ${chalk.cyan(commit.shortHash)}:`,
            initial: suggestion,
        })) as { newMessage: string };

        return response.newMessage.trim();
    } catch (error: any) {
        if (error.message === "canceled") {
            throw new Error("Operation cancelled by user");
        }
        throw error;
    }
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

    lines.push(chalk.dim("\n" + "─".repeat(80)));
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

    const rebaseProc = Bun.spawn({
        cmd: ["git", "rebase", "-i", `HEAD~${count}`],
        cwd: repoDir,
        env,
        stdio: ["inherit", "inherit", "inherit"],
    });

    const exitCode = await rebaseProc.exited;

    // Cleanup temporary files
    try {
        const cleanupProc = Bun.spawn({
            cmd: ["rm", "-rf", messagesDir, indexFilePath, editorScriptPath],
        });
        await cleanupProc.exited;
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
            const statusProc = Bun.spawn({
                cmd: ["git", "status", "--short"],
                cwd: repoDir,
                stdio: ["ignore", "pipe", "pipe"],
            });
            const statusOutput = await new Response(statusProc.stdout).text();
            await statusProc.exited;

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

    // Get current branch
    const currentBranch = await getCurrentBranch(repoDir);

    // Try to find the upstream/remote branch
    let upstreamBranch: string | null = null;
    try {
        const upstreamProc = Bun.spawn({
            cmd: ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            cwd: repoDir,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const upstreamOutput = await new Response(upstreamProc.stdout).text();
        const upstreamExitCode = await upstreamProc.exited;

        if (upstreamExitCode === 0 && upstreamOutput.trim()) {
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
            const checkProc = Bun.spawn({
                cmd: ["git", "rev-parse", "--verify", remoteBranch],
                cwd: repoDir,
                stdio: ["ignore", "pipe", "pipe"],
            });
            const checkExitCode = await checkProc.exited;
            if (checkExitCode === 0) {
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
    const diffProc = Bun.spawn({
        cmd: ["git", "diff", upstreamBranch, "HEAD", "--name-only"],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const [diffOutput, diffExitCode] = await Promise.all([new Response(diffProc.stdout).text(), diffProc.exited]);

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

    // Get current HEAD commit hash
    const headProc = Bun.spawn({
        cmd: ["git", "rev-parse", "HEAD"],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const headHash = (await new Response(headProc.stdout).text()).trim();
    await headProc.exited;

    if (!headHash) {
        logger.warn("⚠️  Could not determine current HEAD commit.");
        return false;
    }

    // Try to find upstream/remote branch
    let upstreamBranch: string | null = null;
    try {
        const upstreamProc = Bun.spawn({
            cmd: ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            cwd: repoDir,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const upstreamOutput = await new Response(upstreamProc.stdout).text();
        const upstreamExitCode = await upstreamProc.exited;

        if (upstreamExitCode === 0 && upstreamOutput.trim()) {
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
            const checkProc = Bun.spawn({
                cmd: ["git", "rev-parse", "--verify", remoteBranch],
                cwd: repoDir,
                stdio: ["ignore", "pipe", "pipe"],
            });
            const checkExitCode = await checkProc.exited;
            if (checkExitCode === 0) {
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
    const remoteHeadProc = Bun.spawn({
        cmd: ["git", "rev-parse", upstreamBranch],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const remoteHeadHash = (await new Response(remoteHeadProc.stdout).text()).trim();
    await remoteHeadProc.exited;

    if (headHash === remoteHeadHash) {
        // HEAD matches remote exactly - safe to proceed
        logger.info(`✅ Current commit matches ${upstreamBranch}`);
        return true;
    }

    // Check if HEAD is an ancestor of remote (meaning remote has all our commits)
    const mergeBaseProc = Bun.spawn({
        cmd: ["git", "merge-base", "--is-ancestor", headHash, upstreamBranch],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const mergeBaseExitCode = await mergeBaseProc.exited;

    if (mergeBaseExitCode === 0) {
        // HEAD is an ancestor of upstream, meaning all commits are pushed
        logger.info(`✅ Current commit is pushed to ${upstreamBranch}`);
        return true;
    }

    // Check if remote is ahead (local is behind) - this is okay, remote has our commits
    const remoteAheadProc = Bun.spawn({
        cmd: ["git", "rev-list", "--count", `${headHash}..${upstreamBranch}`],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const remoteAheadCount = parseInt((await new Response(remoteAheadProc.stdout).text()).trim() || "0");
    await remoteAheadProc.exited;

    if (remoteAheadCount > 0) {
        // Remote is ahead - check if our commits are still on remote
        const localAheadProc = Bun.spawn({
            cmd: ["git", "rev-list", "--count", `${remoteHeadHash}..${headHash}`],
            cwd: repoDir,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const localAheadCount = parseInt((await new Response(localAheadProc.stdout).text()).trim() || "0");
        await localAheadProc.exited;

        if (localAheadCount === 0) {
            // Local has no commits that remote doesn't have - safe (remote is just ahead)
            logger.info(
                `✅ All local commits exist on ${upstreamBranch} (remote is ${remoteAheadCount} commit(s) ahead)`
            );
            return true;
        } else {
            // Local has commits not on remote - check if file contents match (might be rebase)
            const fileDiffProc = Bun.spawn({
                cmd: ["git", "diff", "--name-only", remoteHeadHash, headHash],
                cwd: repoDir,
                stdio: ["ignore", "pipe", "pipe"],
            });
            const fileDiffOutput = await new Response(fileDiffProc.stdout).text();
            await fileDiffProc.exited;

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
    const localAheadProc = Bun.spawn({
        cmd: ["git", "rev-list", "--count", `${remoteHeadHash}..${headHash}`],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const localAheadCount = parseInt((await new Response(localAheadProc.stdout).text()).trim() || "0");
    await localAheadProc.exited;

    if (localAheadCount > 0) {
        // Check if file contents are the same (might be a rebase)
        const fileDiffProc = Bun.spawn({
            cmd: ["git", "diff", "--name-only", remoteHeadHash, headHash],
            cwd: repoDir,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const fileDiffOutput = await new Response(fileDiffProc.stdout).text();
        await fileDiffProc.exited;

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
            logger.warn(`⚠️  Current commit (${headHash.substring(0, 7)}) is not pushed to ${upstreamBranch}`);
            logger.warn(`   Local is ${localAheadCount} commit(s) ahead with ${changedFiles.length} file change(s).`);
            return false;
        }
    }

    // Branches have diverged but local is not ahead - check file contents
    const fileDiffProc = Bun.spawn({
        cmd: ["git", "diff", "--name-only", remoteHeadHash, headHash],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const fileDiffOutput = await new Response(fileDiffProc.stdout).text();
    await fileDiffProc.exited;

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
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            c: "commits",
            h: "help",
            f: "force",
        },
        boolean: ["help", "force"],
        default: {
            commits: undefined,
            force: false,
        },
    });

    if (argv.help) {
        showHelp();
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
        if (!argv.force) {
            const commitsArePushed = await checkCommitsArePushed(repoDir, currentBranch);
            if (!commitsArePushed) {
                logger.error("\n✖ Safety check failed: Current commits are not pushed to origin.");
                logger.error("   Rewriting unpushed commits can be dangerous if something goes wrong.");
                logger.error("   Please push your commits first as a backup:");
                logger.error(`   ${chalk.cyan(`git push origin ${currentBranch}`)}`);
                logger.error("\n   If you're sure you want to proceed anyway, use:");
                logger.error(`   ${chalk.cyan(`tools rename-commits --force`)}`);
                process.exit(1);
            }
        } else {
            logger.warn("⚠️  --force flag used: Skipping safety check.");
            logger.warn("   Proceeding without verifying commits are pushed.");
        }

        // Get number of commits
        let commitCount = argv.commits;

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

            try {
                const response = (await prompter.prompt({
                    type: "numeral",
                    name: "commitCount",
                    message: `How many commits do you want to rename? (1-${recentCommits.length})`,
                    min: 1,
                    max: recentCommits.length,
                })) as { commitCount: number };

                commitCount = response.commitCount;
            } catch (error: any) {
                if (error.message === "canceled") {
                    logger.info("\n🚫 Operation cancelled by user.");
                    process.exit(0);
                }
                throw error;
            }
        }

        const numCommits = Number(commitCount);
        if (!Number.isInteger(numCommits) || numCommits < 1) {
            logger.error("✖ Error: Number of commits must be a positive integer.");
            showHelp();
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

        // Prompt for new messages (oldest first, as they appear in rebase)
        for (let i = 0; i < commits.length; i++) {
            const newMessage = await promptForNewMessage(commits[i], i, commits.length, commits);
            commits[i].newMessage = newMessage;
        }

        // Show confirmation
        console.log(showConfirmation(commits));

        const { confirm } = (await prompter.prompt({
            type: "confirm",
            name: "confirm",
            message: "Do you want to proceed with renaming these commits?",
            initial: true,
        })) as { confirm: boolean };

        if (!confirm) {
            logger.info("\n🚫 Operation cancelled by user.");
            process.exit(0);
        }

        // Perform rebase
        await performRebase(repoDir, commits);

        logger.info("\n✨ All done! Your commits have been renamed.");
    } catch (error: any) {
        if (error.message === "canceled" || error.message?.includes("cancelled")) {
            logger.info("\n🚫 Operation cancelled by user.");
            process.exit(0);
        }
        logger.error(`\n✖ Error: ${error.message}`);
        if (error.stack) {
            logger.debug(error.stack);
        }
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});
