import minimist from "minimist";
import Enquirer from "enquirer";
import { resolve } from "node:path";
import logger from '../logger';

interface Options {
    commits?: number;
    output?: string;
    help?: boolean;
}

interface Args extends Options {
    _: string[];
}

const prompter = new Enquirer();

function showHelp() {
    logger.info(`
Usage: tools git-last-commits-diff <directory> [--commits X] [--output FILE] [--help]

Arguments:
  <directory>     Required. Path to the Git repository.

Options:
  -c, --commits   Number of recent commits to diff (e.g., 5 for HEAD~5..HEAD).
                  If omitted, you'll be prompted to select a specific commit
                  from the last 200 to diff against HEAD.
  -o, --output    Write diff to this file (stdout if omitted).
  -h, --help      Show this message.
`);
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
            h: "help",
        },
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
    const output = argv.output;
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

    if (output) {
        try {
            await Bun.write(output, diffOutput);
            logger.info(`✔ Diff successfully written to ${output}`);
        } catch (writeError) {
            logger.error(`✖ Error writing diff to file ${output}:`, writeError);
            process.exit(1);
        }
    } else {
        process.stdout.write(diffOutput);
        if (!diffOutput.endsWith("\n")) {
            process.stdout.write("\n");
        }
        logger.info(`\n✔ Git diff completed successfully.`);
    }
}

main().catch((err) => {
    logger.error("\n✖ An unexpected error occurred:", err);
    process.exit(1);
});

