import minimist from "minimist";
import Enquirer from "enquirer";
import { resolve } from "node:path";

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
    console.log(`
Usage: diff.ts <directory> [--commits X] [--output FILE] [--help]

Arguments:
  <directory>     Required. Path to the Git repository.

Options:
  -c, --commits   Number of commits to diff (will prompt if missing).
  -o, --output    Write diff to this file (stdout if omitted).
  -h, --help      Show this message.
`);
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
        console.error("✖ Error: Repository directory path is missing or invalid.");
        showHelp();
        process.exit(1);
    }
    const repoDir = resolve(repoDirArg);

    let commits = argv.commits;
    const output = argv.output;

    if (commits === undefined) {
        try {
            const resp = (await prompter.prompt({
                type: "numeral",
                name: "commits",
                message: "How many commits back do you want to diff?",
                initial: 1,
                validate: (input) => {
                    const value = Number(input);
                    return Number.isInteger(value) && value >= 1 ? true : "Please enter a positive integer.";
                },
            })) as { commits?: number };

            commits = resp?.commits;
        } catch (promptError) {
            console.error("\n✖ Prompt cancelled: " + JSON.stringify(promptError));
            process.exit(1);
        }
    }

    let gitExecutablePath = "git";

    const gitArgs = [
        "diff",
        `HEAD~${commits}`,
        "HEAD",
        "-M", // detect renames
        "--unified=15",
        "--ignore-space-at-eol",
        "--no-color",
    ];

    console.debug(`⏳ Running: ${gitExecutablePath} ${gitArgs.join(" ")} in ${repoDir}`);

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
        console.error(`\n✖ git diff exited with code ${exitCode}`);
        if (errorOutput) {
            console.error("Git stderr:");
            console.error(errorOutput.trim());
        }

        // Sometimes git diff writes errors to stdout (e.g., bad revision)
        if (diffOutput && !errorOutput && exitCode !== 0) {
            console.error("Git output (potential error):");
            console.error(diffOutput.trim());
        }
        process.exit(exitCode ?? 1);
    }

    if (output) {
        try {
            await Bun.write(output, diffOutput);
            console.log(`✔ Diff successfully written to ${output}`);
        } catch (writeError) {
            console.error(`✖ Error writing diff to file ${output}:`, writeError);
            process.exit(1);
        }
    } else {
        process.stdout.write(diffOutput);
        if (!diffOutput.endsWith("\n")) {
            process.stdout.write("\n");
        }
        console.log(`\n✔ Git diff completed successfully.`);
    }
}

main().catch((err) => {
    console.error("\n✖ An unexpected error occurred:", err);
    process.exit(1);
});
