import logger from "@app/logger";
import { Executor } from "@app/utils/cli";
import { handleReadmeFlag } from "@app/utils/readme";
import { ExitPromptError } from "@inquirer/core";
import { confirm, select } from "@inquirer/prompts";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { Command } from "commander";
import { z } from "zod";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

async function getGitDiff(git: Executor): Promise<string> {
    const { stdout } = await git.execOrThrow(["diff", "--cached"], "Git diff failed");
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
            model: openRouter("google/gemini-2.0-flash-lite-001") as unknown as Parameters<
                typeof generateObject
            >[0]["model"],
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
            model: openRouter("google/gemini-2.0-flash-lite-001") as unknown as Parameters<
                typeof generateObject
            >[0]["model"],
            schema: z.object({
                messages: z.array(z.string()).length(4).describe("Exactly 4 commit message strings"),
            }),
            prompt,
        });

        return object.messages.map((msg) => ({ summary: msg }));
    }
}

async function main() {
    const program = new Command()
        .name("git-commit")
        .description("Generate commit messages using AI and optionally push")
        .option("-s, --stage", "Stage all changes before committing")
        .option("-d, --detail", "Generate detailed commit messages with body text")
        .option("-v, --verbose", "Enable verbose logging")
        .parse();

    const options = program.opts();
    const git = new Executor({ prefix: "git" });

    try {
        // Stage all changes if requested
        if (options.stage) {
            logger.info("📦 Staging all changes...");
            await git.execOrThrow(["add", "."], "Git add failed");
        }

        // Get the diff of staged changes
        logger.info("📊 Getting diff of staged changes...");
        const diff = await getGitDiff(git);

        if (!diff.trim()) {
            logger.info("✨ No staged changes to commit!");
            if (!options.stage) {
                logger.info("💡 Tip: Use --stage to stage all changes first");
            }
            process.exit(0);
        }

        if (options.verbose) {
            logger.info(`Diff preview:\n${diff.substring(0, 500)}...`);
        }

        // Generate commit messages
        logger.info("🤖 Generating commit messages with AI...");
        const messages = await generateCommitMessages(diff, options.detail || false);

        // Prepare choices for the prompt
        const choices = messages.map((msg, index) => {
            if (msg.detail) {
                // Show both summary and detail in the choice
                return {
                    value: index.toString(),
                    name: `${msg.summary}\n    ${msg.detail.replace(/\n/g, "\n    ")}`,
                };
            } else {
                return {
                    value: index.toString(),
                    name: msg.summary,
                };
            }
        });

        // Let user choose a commit message
        const chosenIndex = await select({
            message: "Choose a commit message:",
            choices: choices,
        });

        const chosenMessage = messages[parseInt(chosenIndex, 10)];

        // Commit with chosen message
        const commitMessage = chosenMessage.detail
            ? `${chosenMessage.summary}\n\n${chosenMessage.detail}`
            : chosenMessage.summary;

        logger.info(`💾 Committing with message: "${chosenMessage.summary}"`);
        await git.execOrThrow(["commit", "-m", commitMessage], "Git commit failed");
        logger.info("✅ Commit successful!");

        // Ask if user wants to push
        const shouldPush = await confirm({
            message: "Do you want to push the changes?",
            default: true,
        });

        if (shouldPush) {
            logger.info("🚀 Pushing changes...");
            await git.execOrThrow(["push"], "Git push failed");
            logger.info("✅ Push successful!");
        }
    } catch (error) {
        if (error instanceof ExitPromptError) {
            logger.info("\n🚫 Operation cancelled by user.");
            process.exit(0);
        }
        logger.error(`✖ Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});
