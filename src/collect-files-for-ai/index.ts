import { mkdir } from "node:fs/promises"; // Using fs.promises for async operations - Bun implements this
import { basename, dirname, join, resolve } from "node:path";
import logger from "@app/logger";
import { Executor } from "@app/utils/cli";
import { handleReadmeFlag } from "@app/utils/readme";
import { Command } from "commander";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

// --- Interfaces ---
interface Options {
    commits?: number;
    staged?: boolean;
    unstaged?: boolean;
    all?: boolean; // Default if no filter is specified
    target?: string;
    flat?: boolean;
}

// --- Helper Functions ---
function getTimestampDirName(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}-${hours}.${minutes}`;
}

async function runGitCommand(git: Executor, args: string[]): Promise<string> {
    const { stdout } = await git.execOrThrow(args);
    logger.debug(` ✔ Git command successful.`);
    return stdout;
}

// --- Main Function ---
async function main() {
    const program = new Command()
        .name("collect-files-for-ai")
        .description("Collect files from Git for AI context")
        .argument("[directory]", "Path to the Git repository", ".")
        .option("-c, --commits <number>", "Collect files changed in the last NUM commits", (val) => parseInt(val, 10))
        .option("-s, --staged", "Collect only staged files")
        .option("-u, --unstaged", "Collect only unstaged files")
        .option("-a, --all", "Collect all uncommitted (staged + unstaged) files")
        .option("-t, --target <directory>", "Directory to copy files into (default: ./.ai/YYYY-MM-DD-HH.mm)")
        .option(
            "-f, --flat",
            "Copy all files directly to the target directory without preserving the directory structure"
        )
        .parse();

    const repoDir = resolve(program.args[0]);
    const git = new Executor({ prefix: "git", cwd: repoDir });
    const options: Options = program.opts();

    logger.debug(`ℹ️ Repository directory: ${repoDir}`);

    const { commits, staged, unstaged, target, flat } = options;
    let all = options.all; // Mutable 'all' flag

    const modeFlags = [commits !== undefined, staged, unstaged, all].filter(Boolean).length;

    if (modeFlags > 1) {
        logger.error("✖ Error: Options --commits, --staged, --unstaged, --all are mutually exclusive.");
        process.exit(1);
    }

    // Default to 'all' if no mode is specified
    let mode: "commits" | "staged" | "unstaged" | "all";
    if (commits !== undefined) {
        if (typeof commits !== "number" || !Number.isInteger(commits) || commits < 1) {
            logger.error(`✖ Error: --commits must be a positive integer. Received: ${commits}`);
            process.exit(1);
        }
        mode = "commits";
        logger.debug(`ℹ️ Mode: Collect files from last ${commits} commits.`);
    } else if (staged) {
        mode = "staged";
        logger.debug(`ℹ️ Mode: Collect staged files.`);
    } else if (unstaged) {
        mode = "unstaged";
        logger.debug(`ℹ️ Mode: Collect unstaged files.`);
    } else {
        // If 'all' was explicitly set or if no other flag was set, use 'all' mode.
        mode = "all";
        all = true; // Ensure 'all' is true if we defaulted here
        logger.debug(`ℹ️ Mode: Collect all uncommitted files (default or --all).`);
    }

    // --- Verify Git Repository ---
    try {
        await runGitCommand(git, ["rev-parse", "--is-inside-work-tree"]);
    } catch (_error) {
        logger.error(`✖ Error: '${repoDir}' does not appear to be a valid Git repository.`);
        // error object already logged in runGitCommand
        process.exit(1);
    }

    // --- Determine Target Directory ---
    let targetDir: string;
    if (target) {
        targetDir = resolve(target);
        logger.debug(`ℹ️ Custom target directory specified: ${targetDir}`);
    } else {
        const timestampDir = getTimestampDirName();
        // Resolve relative to the current working directory (process.cwd()), not repoDir
        targetDir = resolve(process.cwd(), ".ai", timestampDir);
        logger.debug(`ℹ️ Using default target directory: ${targetDir}`);
    }

    // --- Create Target Directory ---
    try {
        await mkdir(targetDir, { recursive: true });
        logger.debug(`✔ Created target directory: ${targetDir}`);
    } catch (error) {
        logger.error(
            "✖ Error creating target directory '%s': %s",
            targetDir,
            error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
    }

    // --- Get File List ---
    let fileList: string[] = [];
    try {
        logger.debug("⏳ Fetching list of changed files...");
        let gitOutput = "";
        if (mode === "commits") {
            gitOutput = await runGitCommand(git, ["diff", "--name-only", "--diff-filter=d", `HEAD~${commits}`, "HEAD"]);
        } else if (mode === "staged") {
            gitOutput = await runGitCommand(git, ["diff", "--name-only", "--diff-filter=d", "--cached"]);
        } else if (mode === "unstaged") {
            // This includes untracked files if they aren't ignored.
            // Consider using status porcelain if only modified/deleted tracked files are needed.
            // For now, diff covers modified/deleted tracked files.
            gitOutput = await runGitCommand(git, ["diff", "--name-only", "--diff-filter=d"]);
        } else {
            // mode === 'all'
            const combined = (await runGitCommand(git, ["diff", "--name-only", "--diff-filter=d", "HEAD"])).split("\n");
            gitOutput = Array.from(combined)
                .filter((f) => f)
                .join("\n"); // Filter out empty lines
        }

        fileList = gitOutput.split("\n").filter((f) => f.trim() !== ""); // Ensure no empty lines
        if (fileList.length === 0) {
            logger.warn("ℹ️ No files found matching the criteria.");
            process.exit(0);
        }
        logger.info(`✔ Found ${fileList.length} file(s) to copy.`);
    } catch (_error) {
        logger.error(`✖ Error getting file list from git.`);
        // Error details should have been logged by runGitCommand
        process.exit(1);
    }

    // --- Copy Files ---
    logger.info(`⏳ Copying files to ${targetDir}${flat ? " (flat)" : ""}...`);
    let copiedCount = 0;
    let skippedCount = 0;

    for (const relativePath of fileList) {
        const sourcePath = join(repoDir, relativePath);
        const sourceFile = Bun.file(sourcePath);

        if (!(await sourceFile.exists())) {
            skippedCount++;
            continue;
        }

        const destPath = flat ? join(targetDir, basename(relativePath)) : join(targetDir, relativePath);
        const destSubDir = dirname(destPath);

        try {
            // Ensure the subdirectory structure exists in the target, only if not flat
            if (!flat) {
                await mkdir(destSubDir, { recursive: true });
            }
            await Bun.write(destPath, sourceFile);
            logger.info(`  → Copied: ${relativePath} ${flat ? `as ${basename(relativePath)}` : ""}`);
            copiedCount++;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.warn(`  ⚠ Failed to copy ${relativePath}: ${msg}`);
            skippedCount++;
        }
    }

    logger.info("\n--- Summary ---");
    logger.info(`Total files found: ${fileList.length}`);
    logger.info(`Successfully copied: ${copiedCount}`);
    if (skippedCount > 0) {
        logger.info(`Skipped (deleted/missing): ${skippedCount}`);
    }
    logger.info(`✔ File collection completed successfully.`);
}

// --- Run Main ---
main().catch((err) => {
    logger.error("\n✖ An unexpected error occurred:", err);
    process.exit(1);
});
