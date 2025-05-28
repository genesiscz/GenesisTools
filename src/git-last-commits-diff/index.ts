import minimist from "minimist";
import Enquirer from "enquirer";
import { resolve, isAbsolute, join as pathJoin } from "node:path";
import logger from '../logger';
import clipboardy from 'clipboardy';

interface Options {
    commits?: number;
    output?: string | boolean; // boolean for -o without value
    clipboard?: boolean;
    help?: boolean;
    testModeClipboardFile?: string; // New option for testing
}

interface Args extends Options {
    _: string[];
}

const prompter = new Enquirer();

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
  -cl, --clipboard Copy diff output directly to the clipboard. This option
                  overrides the interactive prompt. If --output is also given,
                  --output takes precedence.
  -h, --help      Show this message.
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
            logger.error("Git stderr:\n" + stderr.trim());
        } else if (stdout.trim()) { // Some git errors go to stdout
            logger.error("Git stdout (potential error):\n" + stdout.trim());
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

async function getAndSelectCommit(repoDir: string, enquirerInstance: Enquirer): Promise<string | undefined> {
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
            logger.error("Git stderr:\n" + errorOutput.trim());
        } else if (logOutput) { // Some git errors go to stdout
            logger.error("Git stdout (potential error):\n" + logOutput.trim());
        }
        return undefined;
    }

    if (!logOutput.trim()) {
        logger.warn("ℹ No commits found in the repository or the current branch.");
        return undefined;
    }

    const commitsRaw = logOutput.trim().split("\n");
    const choices = commitsRaw.map(line => {
        const match = line.match(/^([a-f0-9]+)\s+(.*)$/);
        let hash: string;
        let displayMessage: string;

        if (!match) {
            logger.warn(`Unexpected commit line format: ${line}`);
            const firstSpaceIndex = line.indexOf(' ');
            hash = firstSpaceIndex > 0 ? line.substring(0, firstSpaceIndex) : line;
            const commitMsgPart = firstSpaceIndex > 0 ? line.substring(firstSpaceIndex + 1) : 'No message';
            displayMessage = `${hash} - ${commitMsgPart}`;
        } else {
            hash = match[1];
            const commitMessage = match[2];
            displayMessage = `${hash} - ${commitMessage}`;
        }
        return {
            name: hash,             // Required by Enquirer's Choice type, also typically the returned value part
            message: displayMessage, // Displayed to the user
        };
    }).filter(choice => choice.name); // Ensure valid name/hash

    if (choices.length === 0) {
        logger.warn("ℹ No processable commits found to select from after parsing.");
        return undefined;
    }

    try {
        const response = await enquirerInstance.prompt({
            type: "autocomplete",
            name: "selectedCommitValue",
            message: "Select a commit (type to filter). The diff will be from this commit to HEAD:",
            choices: choices,
        }) as { selectedCommitValue?: string };

        if (response && typeof response.selectedCommitValue === 'string') {
            return response.selectedCommitValue;
        } else {
            logger.warn("ℹ Commit selection did not return a valid value or was cancelled in an unexpected way.");
            return undefined;
        }
    } catch (promptError: any) {
        if (promptError && (promptError.message === 'canceled' || String(promptError).toLowerCase().includes('cancel'))) {
             logger.info("\nℹ Commit selection cancelled by user.");
        } else {
             logger.error("\n✖ Error during commit selection prompt:", promptError);
        }
        return undefined;
    }
}

async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            c: "commits",
            o: "output",
            cl: "clipboard", // Added alias for clipboard
            h: "help",
        },
        string: ["output", "testModeClipboardFile"], // Ensures value is string
                               // However, --output without a value will make argv.output true.
    });

    if (argv.help || argv._.length === 0) {
        showHelp();
        process.exit(argv.help ? 0 : 1);
    }

    const repoDirArg = argv._[0];
    if (typeof repoDirArg !== "string") {
        logger.error("✖ Error: Repository directory path is missing or invalid.");
        showHelp();
        process.exit(1);
    }
    const repoDir = resolve(repoDirArg);

    let commits = argv.commits;
    const outputFileArg = argv.output; // Renamed for clarity
    const clipboardArg = argv.clipboard;
    const testClipboardFile = argv.testModeClipboardFile; // Get the new arg
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
        const selectedCommitHash = await getAndSelectCommit(repoDir, prompter);

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
    if (typeof outputFileArg === 'string') { // Handles --output FILE and --output ""
        if (outputFileArg.length > 0) {
            outputAction = "file";
            targetPath = resolve(process.cwd(), outputFileArg); // Resolve relative to CWD or use as absolute
            logger.info(`ℹ Output will be written to file: ${targetPath}`);
        } else { // --output ""
            outputAction = "stdout";
            logger.info("ℹ Output will be written to stdout (due to empty --output value).");
        }
    } else if (outputFileArg === true) { // Handles -o without a value
         outputAction = "stdout";
         logger.info("ℹ Output will be written to stdout (due to --output flag without value).");
    } else if (clipboardArg) {
        outputAction = "clipboard";
        logger.info("ℹ Output will be copied to clipboard.");
    } else {
        // Interactive prompt
        logger.info("ℹ No specific output method chosen via flags. Prompting for selection.");
        const outputChoices = [
            { name: "file" as OutputAction, message: "Save to a file (path copied to clipboard)" },
            { name: "clipboard" as OutputAction, message: "Copy to clipboard" },
            { name: "stdout" as OutputAction, message: "Print to stdout (console)" },
        ];

        try {
            const response = await prompter.prompt({
                type: "select",
                name: "selectedAction",
                message: "Where would you like the diff output to go?",
                choices: outputChoices,
            }) as { selectedAction?: OutputAction };

            if (!response || !response.selectedAction) {
                logger.warn("ℹ Output destination selection was cancelled or failed. Exiting.");
                process.exit(0);
            }
            outputAction = response.selectedAction;

            if (outputAction === "file") {
                const firstShaRaw = await getTruncatedSha(repoDir, diffStartRef);
                const lastShaRaw = await getTruncatedSha(repoDir, "HEAD");

                // Handle potentially undefined SHAs for filename
                const firstSha = firstShaRaw ?? (diffStartRef.startsWith("HEAD~") ? diffStartRef.replace("~", "") : "start");
                const lastSha = lastShaRaw ?? "HEAD";

                const defaultFileName = `commits-${firstSha}-${lastSha}.diff`;
                const currentDir = process.cwd();
                const suggestedPath = pathJoin(currentDir, defaultFileName);

                const { filePathResponse } = await prompter.prompt({
                    type: "input",
                    name: "filePathResponse",
                    message: `Enter filename for the diff (will be created in ${currentDir}):`,
                    initial: defaultFileName,
                }) as { filePathResponse?: string };

                if (!filePathResponse || filePathResponse.trim().length === 0) {
                    logger.warn("ℹ No filename provided. Exiting.");
                    process.exit(0);
                }
                targetPath = resolve(currentDir, filePathResponse.trim());
                logger.info(`ℹ Output will be written to file: ${targetPath}`);
            } else if (outputAction === "clipboard") {
                logger.info("ℹ Output will be copied to clipboard.");
            } else { // stdout
                logger.info("ℹ Output will be written to stdout.");
            }
        } catch (promptError: any) {
            if (promptError && (promptError.message === 'canceled' || String(promptError).toLowerCase().includes('cancel'))) {
                 logger.info("\nℹ Output selection cancelled by user. Exiting.");
            } else {
                 logger.error("\n✖ Error during output selection prompt:", promptError);
            }
            process.exit(0);
        }
    }

    let gitExecutablePath = "git";

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
                await clipboardy.write(targetPath);
                logger.info(`✔ Absolute path "${targetPath}" copied to clipboard.`);
            } catch (clipError) {
                logger.error(`✖ Failed to copy file path to clipboard:`, clipError);
                logger.warn(`ℹ You can manually copy the path: ${targetPath}`);
            }
        } else if (outputAction === "clipboard") {
            if (testClipboardFile) {
                const absoluteTestClipboardFile = resolve(process.cwd(), testClipboardFile);
                try {
                    await Bun.write(absoluteTestClipboardFile, diffOutput);
                    logger.info(`[TEST MODE] Diff intended for clipboard written to ${absoluteTestClipboardFile}`);
                    logger.info(`✔ Diff successfully copied to clipboard (via test file: ${absoluteTestClipboardFile}).`);
                } catch (writeError: any) {
                    logger.error(`✖ Failed to write to test clipboard file ${absoluteTestClipboardFile}: ${writeError.message}`);
                    process.exit(1);
                }
            } else {
                await clipboardy.write(diffOutput);
                logger.info("✔ Diff successfully copied to clipboard.");
            }
        } else { // stdout
            process.stdout.write(diffOutput);
            if (!diffOutput.endsWith("\n") && diffOutput.length > 0) { // Ensure newline if content exists
                process.stdout.write("\n");
            }
            logger.info(`\n✔ Git diff completed successfully. Output to stdout.`);
        }
    } catch (finalOutputError) {
        logger.error(`\n✖ An error occurred during final output handling:`, finalOutputError);
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error("\n✖ An unexpected error occurred:", err);
    process.exit(1);
});

