import minimist from "minimist";
import Enquirer from "enquirer";
import chalk from "chalk";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import logger from '../logger';

interface Options {
    help?: boolean;
    verbose?: boolean;
}

interface Args extends Options {
    _: string[];
}

const prompter = new Enquirer();

function showHelp() {
    logger.info(`
Usage: tools git-commit-auto [options]

Automatically stage changes, generate commit messages using AI, and optionally push.

Options:
  -v, --verbose   Enable verbose logging
  -h, --help      Show this help message

Examples:
  tools git-commit-auto
  tools git-commit-auto --verbose
`);
}

async function getGitDiff(): Promise<string> {
    const proc = Bun.spawn({
        cmd: ["git", "diff", "--cached"],
        stdio: ["ignore", "pipe", "pipe"]
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        throw new Error(`Git diff failed: ${stderr}`);
    }

    return stdout;
}

async function generateCommitMessages(diff: string): Promise<string[]> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY environment variable is not set");
    }

    const openRouter = openai({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey,
    });

    const prompt = `Based on the following git diff, generate 4 different concise commit messages that describe the changes. Each message should be clear, follow conventional commit format when appropriate, and be on a new line.

Git diff:
${diff}

Generate 4 commit messages:`;

    const { text } = await generateText({
        model: openRouter('google/gemini-2.0-flash-lite-001'),
        prompt,
    });

    return text.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .slice(0, 4);
}

async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            v: "verbose",
            h: "help"
        },
        boolean: ["verbose", "help"]
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    try {
        // Stage all changes
        logger.info("📦 Staging all changes...");
        const addProc = Bun.spawn({
            cmd: ["git", "add", "."],
            stdio: ["ignore", "pipe", "pipe"]
        });

        const addExitCode = await addProc.exited;
        if (addExitCode !== 0) {
            const stderr = await new Response(addProc.stderr).text();
            throw new Error(`Git add failed: ${stderr}`);
        }

        // Get the diff of staged changes
        logger.info("📊 Getting diff of staged changes...");
        const diff = await getGitDiff();

        if (!diff.trim()) {
            logger.info("✨ No changes to commit!");
            process.exit(0);
        }

        if (argv.verbose) {
            logger.info(`Diff preview:\n${diff.substring(0, 500)}...`);
        }

        // Generate commit messages
        logger.info("🤖 Generating commit messages with AI...");
        const messages = await generateCommitMessages(diff);

        // Let user choose a commit message
        const { chosenMessage } = await prompter.prompt({
            type: "select",
            name: "chosenMessage",
            message: "Choose a commit message:",
            choices: messages
        }) as { chosenMessage: string };

        // Commit with chosen message
        logger.info(`💾 Committing with message: "${chosenMessage}"`);
        const commitProc = Bun.spawn({
            cmd: ["git", "commit", "-m", chosenMessage],
            stdio: ["ignore", "pipe", "pipe"]
        });

        const commitExitCode = await commitProc.exited;
        if (commitExitCode !== 0) {
            const stderr = await new Response(commitProc.stderr).text();
            throw new Error(`Git commit failed: ${stderr}`);
        }

        logger.info("✅ Commit successful!");

        // Ask if user wants to push
        const { shouldPush } = await prompter.prompt({
            type: "confirm",
            name: "shouldPush",
            message: "Do you want to push the changes?",
            initial: true
        }) as { shouldPush: boolean };

        if (shouldPush) {
            logger.info("🚀 Pushing changes...");
            const pushProc = Bun.spawn({
                cmd: ["git", "push"],
                stdio: ["ignore", "pipe", "pipe"]
            });

            const pushExitCode = await pushProc.exited;
            if (pushExitCode !== 0) {
                const stderr = await new Response(pushProc.stderr).text();
                throw new Error(`Git push failed: ${stderr}`);
            }

            logger.info("✅ Push successful!");
        }

    } catch (error: any) {
        if (error.message === 'canceled') {
            logger.info("\n🚫 Operation cancelled by user.");
            process.exit(0);
        }
        logger.error(`✖ Error: ${error.message}`);
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});