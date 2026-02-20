import { join as pathJoin, resolve } from "node:path";
import logger from "@app/logger";
import { handleReadmeFlag } from "@app/utils/readme";
import { ExitPromptError } from "@inquirer/core";
import { input, search, select } from "@inquirer/prompts";
import { copyToClipboard } from "@app/utils/clipboard";
import { Command } from "commander";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

function showHelp() {
    logger.info(`
Usage: tools git-last-commits-diff <directory> [--commits X] [--output FILE | --clipboard] [--help]

Arguments:
  <directory>     Required. Path to the Git repository.

Options:
  -c, --commits   Number of recent commits to diff (e.g., 5 for HEAD~5..HEAD).
                  If omitted, you'll be prompted to select a specific commit
                  from the last 200 to diff against HEAD.
  -o, --output    [FILE] Write diff to this file. If FILE is omitted or empty,
                  output goes to stdout. This option overrides --clipboard
                  and the interactive prompt.
  --clipboard     Copy diff output directly to the clipboard. This option
                  overrides the interactive prompt. If --output is also given,
                  --output takes precedence.
  -?, --help-full Show this message.
`);
}

async function getTruncatedSha(repoDir: string, refName: string): Promise<string | undefined> {
    logger.debug(`⏳ Fetching SHA for ref '${refName}' in ${repoDir}...`);
    const proc = Bun.spawn({
        cmd: ["git", "rev-parse", "--short", refName],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        logger.error(`✖ Failed to get SHA for ref '${refName}'. Exit code: ${exitCode}.`);
        if (stderr.trim()) {
            logger.error(`Git stderr:\n${stderr.trim()}`);
        } else if (stdout.trim()) {
            // Some git errors go to stdout
            logger.error(`Git stdout (potential error):\n${stdout.trim()}`);
        }
        return undefined;
    }
    const trimmedStdout = stdout.trim();
    if (!trimmedStdout) {
        logger.warn(`ℹ No SHA returned for ref '${refName}'.`);
        return undefined;
    }
    logger.debug(`✔ Got SHA for '${refName}': ${trimmedStdout}`);
    return trimmedStdout;
}

async function getAndSelectCommit(repoDir: string): Promise<string | undefined> {
    const gitLogArgs = ["log", "--pretty=format:%h %s", "-n", "200"];
    logger.debug(`⏳ Fetching last 200 commits from ${repoDir}...`);

    const proc = Bun.spawn({
        cmd: ["git", ...gitLogArgs],
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
    });

    let logOutput = "";
    let errorOutput = "";
    const stdoutPromise = new Response(proc.stdout).text().then((text) => (logOutput = text));
    const stderrPromise = new Response(proc.stderr).text().then((text) => (errorOutput = text));

    await Promise.all([stdoutPromise, stderrPromise]);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        logger.error(`
✖ 'git log' command failed with exit code ${exitCode}.`);
        if (errorOutput) {
            logger.error(`Git stderr:\n${errorOutput.trim()}`);
        } else if (logOutput) {
            // Some git errors go to stdout
            logger.error(`Git stdout (potential error):\n${logOutput.trim()}`);
        }
        return undefined;
    }

    if (!logOutput.trim()) {
        logger.warn("ℹ No commits found in the repository or the current branch.");
        return undefined;
    }

    const commitsRaw = logOutput.trim().split("\n");
    const choices = commitsRaw
        .map((line) => {
            const match = line.match(/^([a-f0-9]+)\s+(.*)$/);
            let hash: string;
            let displayMessage: string;

            if (!match) {
                logger.warn(`Unexpected commit line format: ${line}`);
                const firstSpaceIndex = line.indexOf(" ");
                hash = firstSpaceIndex > 0 ? line.substring(0, firstSpaceIndex) : line;
                const commitMsgPart = firstSpaceIndex > 0 ? line.substring(firstSpaceIndex + 1) : "No message";
                displayMessage = `${hash} - ${commitMsgPart}`;
            } else {
                hash = match[1];
                const commitMessage = match[2];
                displayMessage = `${hash} - ${commitMessage}`;
            }
            return {
                value: hash,
                name: displayMessage,
            };
        })
        .filter((choice) => choice.value); // Ensure valid value/hash

    if (choices.length === 0) {
        logger.warn("ℹ No processable commits found to select from after parsing.");
        return undefined;
    }

    try {
        const selectedCommit = await search({
            message: "Select a commit (type to filter). The diff will be from this commit to HEAD:",
            source: async (input) => {
                if (!input) {
                    return choices;
                }
                const lowerInput = input.toLowerCase();
                return choices.filter((choice) => choice.name.toLowerCase().includes(lowerInput));
            },
        });

        return selectedCommit;
    } catch (promptError: any) {
        if (promptError instanceof ExitPromptError) {
            logger.info("\nℹ Commit selection cancelled by user.");
        } else {
            logger.error("\n✖ Error during commit selection prompt:", promptError);
        }
        return undefined;
    }
}

async function main() {
    const program = new Command()
        .name("git-last-commits-diff")
        .argument("[directory]", "Path to the Git repository")
        .option("-c, --commits <number>", "Number of recent commits to diff")
        .option("-o, --output [file]", "Output file path")
        .option("--clipboard", "Copy diff output to clipboard")
        .option("-?, --help-full", "Show this help message")
        .parse();

    const options = program.opts();
    const [repoDirArg] = program.args;

    if (options.helpFull || !repoDirArg) {
        showHelp();
        process.exit(options.helpFull ? 0 : 1);
    }

    if (typeof repoDirArg !== "string") {
        logger.error("✖ Error: Repository directory path is missing or invalid.");
        showHelp();
        process.exit(1);
    }
    const repoDir = resolve(repoDirArg);

    const commits = options.commits ? parseInt(options.commits, 10) : undefined;
    const outputFileArg = options.output; // Renamed for clarity
    const clipboardArg = options.clipboard;
    let diffStartRef: string;

    if (commits !== undefined) {
        const numCommits = Number(commits);
        if (!Number.isInteger(numCommits) || numCommits < 1) {
            logger.error("✖ Error: --commits value must be a positive integer.");
            showHelp();
            process.exit(1);
        }
        diffStartRef = `HEAD~${numCommits}`;
        logger.info(`ℹ Will diff the last ${numCommits} commit(s) (HEAD~${numCommits}..HEAD).`);
    } else {
        logger.info("ℹ --commits flag not provided. Attempting to list recent commits for selection.");
        const selectedCommitHash = await getAndSelectCommit(repoDir);

        if (!selectedCommitHash) {
            logger.info("✖ Commit selection aborted or failed. Exiting.");
            process.exit(0);
        }
        diffStartRef = selectedCommitHash;
        logger.info(`ℹ Selected commit ${selectedCommitHash}. Will diff from this commit to HEAD.`);
    }

    type OutputAction = "file" | "clipboard" | "stdout";
    let outputAction: OutputAction;
    let targetPath: string | undefined; // Full absolute path for file output

    // Determine output action
    if (typeof outputFileArg === "string") {
        // Handles --output FILE and --output ""
        if (outputFileArg.length > 0) {
            outputAction = "file";
            targetPath = resolve(process.cwd(), outputFileArg); // Resolve relative to CWD or use as absolute
            logger.info(`ℹ Output will be written to file: ${targetPath}`);
        } else {
            // --output ""
            outputAction = "stdout";
            logger.info("ℹ Output will be written to stdout (due to empty --output value).");
        }
    } else if (outputFileArg === true) {
        // Handles -o without a value
        outputAction = "stdout";
        logger.info("ℹ Output will be written to stdout (due to --output flag without value).");
    } else if (clipboardArg) {
        outputAction = "clipboard";
        logger.info("ℹ Output will be copied to clipboard.");
    } else {
        // Interactive prompt
        logger.info("ℹ No specific output method chosen via flags. Prompting for selection.");
        const outputChoices = [
            { value: "file" as OutputAction, name: "Save to a file (path copied to clipboard)" },
            { value: "clipboard" as OutputAction, name: "Copy to clipboard" },
            { value: "stdout" as OutputAction, name: "Print to stdout (console)" },
        ];

        try {
            outputAction = await select({
                message: "Where would you like the diff output to go?",
                choices: outputChoices,
            });

            if (outputAction === "file") {
                const firstShaRaw = await getTruncatedSha(repoDir, diffStartRef);
                const lastShaRaw = await getTruncatedSha(repoDir, "HEAD");

                // Handle potentially undefined SHAs for filename
                const firstSha =
                    firstShaRaw ?? (diffStartRef.startsWith("HEAD~") ? diffStartRef.replace("~", "") : "start");
                const lastSha = lastShaRaw ?? "HEAD";

                const defaultFileName = `commits-${firstSha}-${lastSha}.diff`;
                const currentDir = process.cwd();
                const _suggestedPath = pathJoin(currentDir, defaultFileName);

                const filePathResponse = await input({
                    message: `Enter filename for the diff (will be created in ${currentDir}):`,
                    default: defaultFileName,
                });

                if (!filePathResponse || filePathResponse.trim().length === 0) {
                    logger.warn("ℹ No filename provided. Exiting.");
                    process.exit(0);
                }
                targetPath = resolve(currentDir, filePathResponse.trim());
                logger.info(`ℹ Output will be written to file: ${targetPath}`);
            } else if (outputAction === "clipboard") {
                logger.info("ℹ Output will be copied to clipboard.");
            } else {
                // stdout
                logger.info("ℹ Output will be written to stdout.");
            }
        } catch (promptError: any) {
            if (promptError instanceof ExitPromptError) {
                logger.info("\nℹ Output selection cancelled by user. Exiting.");
            } else {
                logger.error("\n✖ Error during output selection prompt:", promptError);
            }
            process.exit(0);
        }
    }

    const gitExecutablePath = "git";

    const gitArgs = [
        "diff",
        diffStartRef,
        "HEAD",
        "-M", // detect renames
        "--unified=15",
        "--ignore-space-at-eol",
        "--no-color",
    ];

    logger.debug(`⏳ Running: ${gitExecutablePath} ${gitArgs.join(" ")} in ${repoDir}`);

    const proc = Bun.spawn({
        cmd: [gitExecutablePath, ...gitArgs],
        cwd: repoDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"], // pipe stdout and stderr
    });

    let diffOutput = "";
    let errorOutput = "";

    const stdoutPromise = new Response(proc.stdout).text().then((text) => (diffOutput = text));
    const stderrPromise = new Response(proc.stderr).text().then((text) => (errorOutput = text));

    await Promise.all([stdoutPromise, stderrPromise]);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        logger.error(`\n✖ git diff exited with code ${exitCode}`);
        if (errorOutput) {
            logger.error("Git stderr:");
            logger.error(errorOutput.trim());
        }

        // Sometimes git diff writes errors to stdout (e.g., bad revision)
        if (diffOutput && !errorOutput && exitCode !== 0) {
            logger.error("Git output (potential error):");
            logger.error(diffOutput.trim());
        }
        process.exit(exitCode ?? 1);
    }

    // Perform the output action
    try {
        if (outputAction === "file" && targetPath) {
            await Bun.write(targetPath, diffOutput);
            logger.info(`✔ Diff successfully written to ${targetPath}`);
            try {
                await copyToClipboard(targetPath, { silent: true });
                logger.info(`✔ Absolute path "${targetPath}" copied to clipboard.`);
            } catch (clipError) {
                logger.error(`✖ Failed to copy file path to clipboard: ${clipError}`);
                logger.warn(`ℹ You can manually copy the path: ${targetPath}`);
            }
        } else if (outputAction === "clipboard") {
            if (diffOutput.trim().length === 0) {
                logger.info("ℹ Diff output is empty. Nothing to copy to clipboard.");
            } else {
                await copyToClipboard(diffOutput, { silent: true });
                logger.info(`✔ Diff successfully copied to clipboard.`);
            }
        } else {
            // stdout
            process.stdout.write(diffOutput);
            if (!diffOutput.endsWith("\n") && diffOutput.length > 0) {
                // Ensure newline if content exists
                process.stdout.write("\n");
            }
            logger.info(`\n✔ Git diff completed successfully. Output to stdout.`);
        }
    } catch (finalOutputError) {
        logger.error(`\n✖ An error occurred during final output handling: ${finalOutputError}`);
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error("\n✖ An unexpected error occurred:", err);
    process.exit(1);
});
