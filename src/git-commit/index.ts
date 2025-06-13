import minimist from "minimist";
import Enquirer from "enquirer";
import { generateObject } from "ai";
import { z } from "zod";
import logger from "../logger";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

interface Options {
    help?: boolean;
    verbose?: boolean;
    detail?: boolean;
    stage?: boolean;
}

interface Args extends Options {
    _: string[];
}

const prompter = new Enquirer();

function showHelp() {
    console.log(`
Usage: tools git-commit [options]

Generate commit messages using AI and optionally push.

Options:
  -s, --stage     Stage all changes before committing
  -d, --detail    Generate detailed commit messages with body text
  -v, --verbose   Enable verbose logging
  -h, --help      Show this help message

Examples:
  tools git-commit                    # Generate commit for staged changes
  tools git-commit --stage            # Stage all changes first
  tools git-commit --detail           # Generate commits with detailed descriptions
  tools git-commit --stage --detail   # Stage changes and generate detailed commits
`);
}

async function getGitDiff(): Promise<string> {
    const proc = Bun.spawn({
        cmd: ["git", "diff", "--cached"],
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        throw new Error(`Git diff failed: ${stderr}`);
    }

    return stdout;
}

interface CommitMessage {
    summary: string;
    detail?: string;
}

async function generateCommitMessages(diff: string, includeDetail: boolean): Promise<CommitMessage[]> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY environment variable is not set");
    }

    const openRouter = createOpenRouter({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
    });

    if (includeDetail) {
        const prompt = `Based on the following git diff, generate 4 different commit messages. Each should have:
1. A concise summary line (optimal to 72 chars, max 72 chars) following conventional commit format
2. A detailed body explaining in bullet points (prefixed with "-") about what changed and why

Git diff:
${diff}`;

        const { object } = await generateObject({
            model: openRouter("google/gemini-2.0-flash-lite-001"),
            schema: z.object({
                commits: z
                    .array(
                        z.object({
                            summary: z.string().describe("Concise commit summary line"),
                            detail: z.string().describe("Detailed explanation of changes"),
                        })
                    )
                    .length(4)
                    .describe("Exactly 4 commit messages with summaries and details"),
            }),
            prompt,
        });

        return object.commits;
    } else {
        const prompt = `Based on the following git diff, generate 4 different concise commit messages that describe the changes. Each message should be clear, follow conventional commit format when appropriate.

Git diff:
${diff}`;

        const { object } = await generateObject({
            model: openRouter("google/gemini-2.0-flash-lite-001"),
            schema: z.object({
                messages: z.array(z.string()).length(4).describe("Exactly 4 commit message strings"),
            }),
            prompt,
        });

        return object.messages.map((msg) => ({ summary: msg }));
    }
}

async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            v: "verbose",
            h: "help",
            d: "detail",
            s: "stage",
        },
        boolean: ["verbose", "help", "detail", "stage"],
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    try {
        // Stage all changes if requested
        if (argv.stage) {
            logger.info("📦 Staging all changes...");
            const addProc = Bun.spawn({
                cmd: ["git", "add", "."],
                stdio: ["ignore", "pipe", "pipe"],
            });

            const addExitCode = await addProc.exited;
            if (addExitCode !== 0) {
                const stderr = await new Response(addProc.stderr).text();
                throw new Error(`Git add failed: ${stderr}`);
            }
        }

        // Get the diff of staged changes
        logger.info("📊 Getting diff of staged changes...");
        const diff = await getGitDiff();

        if (!diff.trim()) {
            logger.info("✨ No staged changes to commit!");
            if (!argv.stage) {
                logger.info("💡 Tip: Use --stage to stage all changes first");
            }
            process.exit(0);
        }

        if (argv.verbose) {
            logger.info(`Diff preview:\n${diff.substring(0, 500)}...`);
        }

        // Generate commit messages
        logger.info("🤖 Generating commit messages with AI...");
        const messages = await generateCommitMessages(diff, argv.detail || false);

        // Prepare choices for the prompt
        const choices = messages.map((msg, index) => {
            if (msg.detail) {
                // Show both summary and detail in the choice
                return {
                    name: index.toString(),
                    message: `${msg.summary}\n    ${msg.detail.replace(/\n/g, "\n    ")}`,
                };
            } else {
                return {
                    name: index.toString(),
                    message: msg.summary,
                };
            }
        });

        // Let user choose a commit message
        const { chosenIndex } = (await prompter.prompt({
            type: "select",
            name: "chosenIndex",
            message: "Choose a commit message:",
            choices: choices,
        })) as { chosenIndex: string };

        const chosenMessage = messages[parseInt(chosenIndex)];

        // Commit with chosen message
        const commitMessage = chosenMessage.detail
            ? `${chosenMessage.summary}\n\n${chosenMessage.detail}`
            : chosenMessage.summary;

        logger.info(`💾 Committing with message: "${chosenMessage.summary}"`);

        const commitProc = Bun.spawn({
            cmd: ["git", "commit", "-m", commitMessage],
            stdio: ["ignore", "pipe", "pipe"],
        });

        const commitExitCode = await commitProc.exited;
        if (commitExitCode !== 0) {
            const stderr = await new Response(commitProc.stderr).text();
            throw new Error(`Git commit failed: ${stderr}`);
        }

        logger.info("✅ Commit successful!");

        // Ask if user wants to push
        const { shouldPush } = (await prompter.prompt({
            type: "confirm",
            name: "shouldPush",
            message: "Do you want to push the changes?",
            initial: true,
        })) as { shouldPush: boolean };

        if (shouldPush) {
            logger.info("🚀 Pushing changes...");
            const pushProc = Bun.spawn({
                cmd: ["git", "push"],
                stdio: ["ignore", "pipe", "pipe"],
            });

            const pushExitCode = await pushProc.exited;
            if (pushExitCode !== 0) {
                const stderr = await new Response(pushProc.stderr).text();
                throw new Error(`Git push failed: ${stderr}`);
            }

            logger.info("✅ Push successful!");
        }
    } catch (error: any) {
        if (error.message === "" || error.message === "canceled") {
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
