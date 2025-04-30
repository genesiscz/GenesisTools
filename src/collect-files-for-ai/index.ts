import minimist from "minimist";
import { resolve, join, dirname } from "node:path";
import { mkdir } from "node:fs/promises"; // Using fs.promises for async operations - Bun implements this

// --- Interfaces ---
interface Options {
    commits?: number;
    staged?: boolean;
    unstaged?: boolean;
    all?: boolean; // Default if no filter is specified
    target?: string;
    help?: boolean;
    // Aliases
    s?: boolean;
    u?: boolean;
    a?: boolean;
    c?: number;
    t?: string;
    h?: boolean;
}

interface Args extends Options {
    _: string[]; // Positional arguments
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

async function runGitCommand(args: string[], cwd: string): Promise<string> {
    console.log(` M Running: git ${args.join(" ")} in ${cwd}`);
    const proc = Bun.spawn({
        cmd: ["git", ...args],
        cwd: cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        console.error(`\n✖ git command failed with code ${exitCode}`);
        if (stderr) {
            console.error("Git stderr:");
            console.error(stderr.trim());
        }
        // Sometimes errors go to stdout
        if (stdout && !stderr) {
            console.error("Git stdout (potential error):");
            console.error(stdout.trim());
        }
        throw new Error(`Git command failed: git ${args.join(" ")}`);
    }
    console.log(` ✔ Git command successful.`);
    return stdout.trim();
}

// --- Help Function ---
function showHelp() {
    console.log(`
Usage: collect-uncommitted-files.ts <directory> [options]

Arguments:
  <directory>         Required. Path to the Git repository.

Options:
  Mode (choose one, default is --all if --commits is not used):
    -c, --commits NUM   Collect files changed in the last NUM commits.
    -s, --staged        Collect only staged files.
    -u, --unstaged      Collect only unstaged files.
    -a, --all           Collect all uncommitted (staged + unstaged) files.

  Output:
    -t, --target DIR    Directory to copy files into (default: ./.ai/YYYY-MM-DD-HH.mm).
    -h, --help          Show this message.

Examples:
  bun run src/git/collect-uncommitted-files.ts ./my-repo -c 5
  bun run src/git/collect-uncommitted-files.ts ../other-repo --staged --target ./collected_staged
  bun run src/git/collect-uncommitted-files.ts /path/to/project --all
`);
}

// --- Main Function ---
async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        boolean: ["staged", "unstaged", "all", "help"],
        string: ["target"],
        alias: {
            c: "commits",
            s: "staged",
            u: "unstaged",
            a: "all",
            t: "target",
            h: "help",
        },
    });

    // --- Argument Validation ---
    if (argv.help || argv._.length === 0) {
        showHelp();
        process.exit(argv.help ? 0 : 1);
    }

    const repoDirArg = argv._[0];
    if (typeof repoDirArg !== "string") {
        console.error("✖ Error: Repository directory path is missing or invalid.");
        showHelp();
        process.exit(1);
    }
    const repoDir = resolve(repoDirArg);
    console.log(`ℹ️ Repository directory: ${repoDir}`);

    const { commits, staged, unstaged, target } = argv;
    let all = argv.all; // Mutable 'all' flag

    const modeFlags = [commits !== undefined, staged, unstaged, all].filter(Boolean).length;

    if (modeFlags > 1) {
        console.error("✖ Error: Options --commits, --staged, --unstaged, --all are mutually exclusive.");
        showHelp();
        process.exit(1);
    }

    // Default to 'all' if no mode is specified
    let mode: "commits" | "staged" | "unstaged" | "all";
    if (commits !== undefined) {
        if (typeof commits !== "number" || !Number.isInteger(commits) || commits < 1) {
            console.error(`✖ Error: --commits must be a positive integer. Received: ${commits}`);
            process.exit(1);
        }
        mode = "commits";
        console.log(`ℹ️ Mode: Collect files from last ${commits} commits.`);
    } else if (staged) {
        mode = "staged";
        console.log(`ℹ️ Mode: Collect staged files.`);
    } else if (unstaged) {
        mode = "unstaged";
        console.log(`ℹ️ Mode: Collect unstaged files.`);
    } else {
        // If 'all' was explicitly set or if no other flag was set, use 'all' mode.
        mode = "all";
        all = true; // Ensure 'all' is true if we defaulted here
        console.log(`ℹ️ Mode: Collect all uncommitted files (default or --all).`);
    }

    // --- Verify Git Repository ---
    try {
        await runGitCommand(["rev-parse", "--is-inside-work-tree"], repoDir);
    } catch (error) {
        console.error(`✖ Error: '${repoDir}' does not appear to be a valid Git repository.`);
        // error object already logged in runGitCommand
        process.exit(1);
    }

    // --- Determine Target Directory ---
    let targetDir: string;
    if (target) {
        targetDir = resolve(target);
        console.log(`ℹ️ Custom target directory specified: ${targetDir}`);
    } else {
        const timestampDir = getTimestampDirName();
        // Resolve relative to the current working directory (process.cwd()), not repoDir
        targetDir = resolve(process.cwd(), ".ai", timestampDir);
        console.log(`ℹ️ Using default target directory: ${targetDir}`);
    }

    // --- Create Target Directory ---
    try {
        await mkdir(targetDir, { recursive: true });
        console.log(`✔ Created target directory: ${targetDir}`);
    } catch (error: any) {
        console.error(`✖ Error creating target directory '${targetDir}':`, error.message);
        process.exit(1);
    }

    // --- Get File List ---
    let fileList: string[] = [];
    try {
        console.log("⏳ Fetching list of changed files...");
        let gitOutput = "";
        if (mode === "commits") {
            gitOutput = await runGitCommand(["diff", "--name-only", `HEAD~${commits}`, "HEAD"], repoDir);
        } else if (mode === "staged") {
            gitOutput = await runGitCommand(["diff", "--name-only", "--cached"], repoDir);
        } else if (mode === "unstaged") {
            // This includes untracked files if they aren't ignored.
            // Consider using status porcelain if only modified/deleted tracked files are needed.
            // For now, diff covers modified/deleted tracked files.
            gitOutput = await runGitCommand(["diff", "--name-only"], repoDir);
        } else {
            // mode === 'all'
            const stagedFiles = await runGitCommand(["diff", "--name-only", "--cached"], repoDir);
            const unstagedFiles = await runGitCommand(["diff", "--name-only"], repoDir);
            // Combine and deduplicate
            const combined = new Set([...stagedFiles.split("\n"), ...unstagedFiles.split("\n")]);
            gitOutput = Array.from(combined)
                .filter((f) => f)
                .join("\n"); // Filter out empty lines
        }

        fileList = gitOutput.split("\n").filter((f) => f.trim() !== ""); // Ensure no empty lines
        if (fileList.length === 0) {
            console.log("ℹ️ No files found matching the criteria.");
            process.exit(0);
        }
        console.log(`✔ Found ${fileList.length} file(s) to copy.`);
    } catch (error) {
        console.error(`✖ Error getting file list from git.`);
        // Error details should have been logged by runGitCommand
        process.exit(1);
    }

    // --- Copy Files ---
    console.log(`⏳ Copying files to ${targetDir}...`);
    let copiedCount = 0;
    let errorCount = 0;

    for (const relativePath of fileList) {
        const sourcePath = join(repoDir, relativePath);
        const destPath = join(targetDir, relativePath);
        const destSubDir = dirname(destPath);

        try {
            // Ensure the subdirectory structure exists in the target
            await mkdir(destSubDir, { recursive: true });
            // Use Bun.write to copy - simpler than node:fs/promises cp for this case
            await Bun.write(destPath, Bun.file(sourcePath));
            // Alternative using fs.promises.cp:
            // await cp(sourcePath, destPath, { recursive: true, force: true }); // force overwrites - REMOVED
            console.log(`  → Copied: ${relativePath}`);
            copiedCount++;
        } catch (error: any) {
            console.error(`  ✖ Error copying ${relativePath}: ${error.message}`);
            errorCount++;
        }
    }

    // --- Final Summary ---
    console.log("\n--- Summary ---");
    console.log(`Total files found: ${fileList.length}`);
    console.log(`Successfully copied: ${copiedCount}`);
    if (errorCount > 0) {
        console.error(`Copying errors: ${errorCount}`);
        process.exit(1); // Exit with error if any copy failed
    } else {
        console.log(`✔ File collection completed successfully.`);
    }
}

// --- Run Main ---
main().catch((err) => {
    console.error("\n✖ An unexpected error occurred:", err);
    process.exit(1);
});
