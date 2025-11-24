import minimist from "minimist";
import Enquirer from "enquirer";
import { resolve } from "node:path";
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

async function getCommits(repoDir: string, count: number): Promise<CommitInfo[]> {
    logger.debug(`⏳ Fetching last ${count} commits from ${repoDir}...`);

    const proc = Bun.spawn({
        cmd: ["git", "log", `-n`, `${count}`, "--pretty=format:%H|%h|%s", "--no-decorate"],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        throw new Error(`Failed to get commits: ${stderr.trim()}`);
    }

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
    return commits.reverse();
}

async function promptForNewMessage(commit: CommitInfo, index: number, total: number): Promise<string> {
    try {
        // Show current message clearly before the prompt
        console.log(chalk.dim(`\n  Current message: ${chalk.reset(commit.message)}`));

        const response = (await prompter.prompt({
            type: "input",
            name: "newMessage",
            message: `[${index + 1}/${total}] Enter new message for commit ${chalk.cyan(commit.shortHash)}:`,
            initial: commit.message,
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

async function performRebase(repoDir: string, commits: CommitInfo[]): Promise<void> {
    const count = commits.length;
    logger.info(`🔄 Starting interactive rebase for ${count} commit(s)...`);

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
    const editorScript =
        `#!/bin/bash
idx=$(cat "${indexFilePath}" 2>/dev/null | tr -d '[:space:]' || echo 0)
msgfile="${messagesDir}/` +
        "${idx}" +
        `.txt"
if [ -f "$msgfile" ]; then
    cat "$msgfile" > "$1"
    echo $((idx + 1)) > "${indexFilePath}"
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

    if (exitCode !== 0) {
        throw new Error(
            `Git rebase failed with exit code ${exitCode}. The rebase may have been aborted or there may be conflicts.`
        );
    }

    logger.info("✅ Commits successfully renamed!");
}

async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            c: "commits",
            h: "help",
        },
        default: {
            commits: undefined,
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

        // Get number of commits
        let commitCount = argv.commits;

        if (!commitCount) {
            // Show last 50 commits numbered so user can see which ones will be renamed
            logger.info("📋 Fetching last 50 commits...");
            const recentCommitsRaw = await getCommits(repoDir, 50);

            if (recentCommitsRaw.length === 0) {
                logger.warn("ℹ No commits found.");
                process.exit(0);
            }

            // Reverse to show newest first (getCommits returns oldest first for rebase)
            const recentCommits = [...recentCommitsRaw].reverse();

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
                    initial: 3,
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

        // Get commits
        logger.info(`📋 Fetching last ${numCommits} commit(s)...`);
        const commits = await getCommits(repoDir, numCommits);

        if (commits.length === 0) {
            logger.warn("ℹ No commits found.");
            process.exit(0);
        }

        logger.info(`📝 Found ${commits.length} commit(s). Let's rename them:`);

        // Prompt for new messages (oldest first, as they appear in rebase)
        for (let i = 0; i < commits.length; i++) {
            const newMessage = await promptForNewMessage(commits[i], i, commits.length);
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
