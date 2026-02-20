// GitHub CLI Tool - Main Entry Point

import { activityCommand, createActivityCommand } from "@app/github/commands/activity";
import { createCodeSearchCommand } from "@app/github/commands/code-search";
import { commentsCommand, createCommentsCommand } from "@app/github/commands/comments";
import { createGetCommand, getCommand } from "@app/github/commands/get";
import { createIssueCommand, issueCommand } from "@app/github/commands/issue";
import { createNotificationsCommand, notificationsCommand } from "@app/github/commands/notifications";
import { createPRCommand, prCommand } from "@app/github/commands/pr";
import { createReviewCommand, reviewCommand } from "@app/github/commands/review";
import { createSearchCommand, searchCommand } from "@app/github/commands/search";
import { closeDatabase, getCacheStats } from "@app/github/lib/cache";
import logger from "@app/logger";
import { enhanceHelp } from "@app/utils/cli";
import { checkAuth, getRateLimit } from "@app/utils/github/octokit";
import { detectRepoFromGit, parseGitHubUrl } from "@app/utils/github/url-parser";
import { ExitPromptError } from "@inquirer/core";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { Command } from "commander";

const program = new Command();

program.name("github").description("GitHub CLI tool for fetching issues, PRs, and comments").version("1.0.0");

// Add subcommands
program.addCommand(createIssueCommand());
program.addCommand(createPRCommand());
program.addCommand(createCommentsCommand());
program.addCommand(createSearchCommand());
program.addCommand(createCodeSearchCommand());
program.addCommand(createGetCommand());
program.addCommand(createReviewCommand());
program.addCommand(createNotificationsCommand());
program.addCommand(createActivityCommand());

// Status command
program
    .command("status")
    .description("Show authentication and cache status")
    .action(async () => {
        console.log(chalk.bold("GitHub Tool Status\n"));

        // Auth status
        console.log(chalk.underline("Authentication:"));
        const auth = await checkAuth();
        if (auth.authenticated) {
            console.log(chalk.green(`  ✔ Authenticated as @${auth.user}`));
            if (auth.scopes && auth.scopes.length > 0) {
                console.log(chalk.dim(`  Scopes: ${auth.scopes.join(", ")}`));
            }
        } else {
            console.log(chalk.yellow("  ✘ Not authenticated (limited access)"));
        }

        // Rate limit
        console.log(chalk.underline("\nRate Limit:"));
        try {
            const rateLimit = await getRateLimit();
            console.log(`  Remaining: ${rateLimit.remaining}/${rateLimit.limit}`);
            console.log(`  Resets: ${rateLimit.reset.toLocaleTimeString()}`);
        } catch {
            console.log(chalk.dim("  Could not fetch rate limit"));
        }

        // Cache stats
        console.log(chalk.underline("\nCache:"));
        const stats = getCacheStats();
        console.log(`  Repos: ${stats.repos}`);
        console.log(`  Issues/PRs: ${stats.issues}`);
        console.log(`  Comments: ${stats.comments}`);
        console.log(`  Events: ${stats.events}`);
    });

enhanceHelp(program);

// Interactive mode (no subcommand)
async function interactiveMode(): Promise<void> {
    console.log(chalk.bold.blue("🔧 GitHub Tool - Interactive Mode\n"));

    // Check auth first
    const auth = await checkAuth();
    if (auth.authenticated) {
        console.log(chalk.dim(`Authenticated as @${auth.user}\n`));
    } else {
        console.log(chalk.yellow("Not authenticated. Some features may be limited.\n"));
    }

    while (true) {
        try {
            const action = await select({
                message: "What would you like to do?",
                choices: [
                    { value: "notifications", name: "🔔 Notifications" },
                    { value: "activity", name: "📊 Activity Feed" },
                    { value: "issue", name: "📋 Fetch Issue" },
                    { value: "pr", name: "🔀 Fetch Pull Request" },
                    { value: "review", name: "📝 Review PR Threads" },
                    { value: "comments", name: "💬 Fetch Comments" },
                    { value: "search", name: "🔍 Search Issues/PRs" },
                    { value: "get", name: "📄 Get File Content" },
                    { value: "status", name: "ℹ️  Show Status" },
                    { value: "exit", name: "👋 Exit" },
                ],
            });

            if (action === "exit") {
                console.log(chalk.dim("Goodbye!"));
                break;
            }

            if (action === "status") {
                await program.commands.find((c) => c.name() === "status")?.parseAsync(["node", "github", "status"]);
                continue;
            }

            // Get input URL or search query
            let urlInput: string;

            if (action === "search") {
                urlInput = await input({
                    message: "Enter search query:",
                });

                if (!urlInput.trim()) {
                    console.log(chalk.yellow("No query provided."));
                    continue;
                }

                // Search options
                const typeFilter = await select({
                    message: "Filter by type:",
                    choices: [
                        { value: "all", name: "All" },
                        { value: "issue", name: "Issues only" },
                        { value: "pr", name: "PRs only" },
                    ],
                });

                const stateFilter = await select({
                    message: "Filter by state:",
                    choices: [
                        { value: "all", name: "All" },
                        { value: "open", name: "Open only" },
                        { value: "closed", name: "Closed only" },
                    ],
                });

                const limit = await input({
                    message: "Max results:",
                    default: "30",
                });

                await searchCommand(urlInput, {
                    type: typeFilter as "issue" | "pr" | "all",
                    state: stateFilter as "open" | "closed" | "all",
                    limit: parseInt(limit, 10),
                    format: "ai",
                });

                continue;
            }

            if (action === "review") {
                const prUrl = await input({ message: "Enter PR number or URL:" });
                if (!prUrl.trim()) {
                    console.log(chalk.yellow("No input provided."));
                    continue;
                }
                const unresolvedOnly = await confirm({ message: "Show only unresolved?", default: true });
                const groupByFile = await confirm({ message: "Group by file?", default: true });
                const outputFormat = await select({
                    message: "Output format:",
                    choices: [
                        { value: "terminal", name: "Terminal (colorized)" },
                        { value: "md", name: "Markdown (save to file)" },
                        { value: "json", name: "JSON" },
                    ],
                });
                await reviewCommand(prUrl, {
                    unresolvedOnly,
                    groupByFile,
                    md: outputFormat === "md",
                    json: outputFormat === "json",
                });
                continue;
            }

            if (action === "notifications") {
                const stateFilter = await select({
                    message: "Show notifications:",
                    choices: [
                        { value: "all", name: "All" },
                        { value: "unread", name: "Unread only" },
                        { value: "read", name: "Read only" },
                    ],
                });

                const sinceFilter = await select({
                    message: "Time range:",
                    choices: [
                        { value: undefined, name: "All time" },
                        { value: "1d", name: "Last 24 hours" },
                        { value: "7d", name: "Last 7 days" },
                        { value: "30d", name: "Last 30 days" },
                    ],
                });

                const repoFilter = await input({
                    message: "Filter by repo (owner/repo, or empty for all):",
                });

                await notificationsCommand({
                    state: stateFilter as "read" | "unread" | "all",
                    since: sinceFilter ?? undefined,
                    repo: repoFilter.trim() || undefined,
                    format: "ai",
                });

                continue;
            }

            if (action === "activity") {
                const sinceFilter = await select({
                    message: "Time range:",
                    choices: [
                        { value: "1d", name: "Last 24 hours" },
                        { value: "7d", name: "Last 7 days" },
                        { value: "30d", name: "Last 30 days" },
                    ],
                });

                const typeFilter = await select({
                    message: "Event type:",
                    choices: [
                        { value: undefined, name: "All" },
                        { value: "push", name: "Pushes" },
                        { value: "pr", name: "Pull Requests" },
                        { value: "issue", name: "Issues" },
                        { value: "comment", name: "Comments" },
                    ],
                });

                await activityCommand({
                    since: sinceFilter ?? undefined,
                    type: typeFilter ?? undefined,
                    format: "ai",
                });
                continue;
            }

            if (action === "get") {
                const fileUrl = await input({
                    message: "Enter GitHub file URL:",
                });

                if (!fileUrl.trim()) {
                    console.log(chalk.yellow("No URL provided."));
                    continue;
                }

                const toClipboard = await confirm({
                    message: "Copy to clipboard?",
                    default: false,
                });

                await getCommand(fileUrl, { clipboard: toClipboard });
                continue;
            }

            // Issue, PR, or Comments
            urlInput = await input({
                message: "Enter URL or issue/PR number:",
            });

            if (!urlInput.trim()) {
                console.log(chalk.yellow("No input provided."));
                continue;
            }

            // Try to parse the URL
            const defaultRepo = (await detectRepoFromGit()) || undefined;
            const parsed = parseGitHubUrl(urlInput, defaultRepo);

            if (!parsed && !defaultRepo) {
                console.log(
                    chalk.red(
                        "Could not parse input. Please provide a full GitHub URL or use --repo owner/repo option."
                    )
                );
                continue;
            }

            // Common options
            const includeComments = await confirm({
                message: "Include comments?",
                default: true,
            });

            let limit: number | undefined;
            let last: number | undefined;
            let noBots = false;
            let minReactions: number | undefined;

            if (includeComments) {
                const commentMode = await select({
                    message: "Comment selection:",
                    choices: [
                        { value: "limit", name: "Limit to N comments" },
                        { value: "last", name: "Last N comments" },
                        { value: "all", name: "All comments" },
                    ],
                });

                if (commentMode === "limit" || commentMode === "last") {
                    const n = await input({
                        message: `How many comments?`,
                        default: "30",
                    });
                    if (commentMode === "limit") {
                        limit = parseInt(n, 10);
                    } else {
                        last = parseInt(n, 10);
                    }
                }

                noBots = await confirm({
                    message: "Exclude bot comments?",
                    default: false,
                });

                const filterReactions = await confirm({
                    message: "Filter by minimum reactions?",
                    default: false,
                });

                if (filterReactions) {
                    const n = await input({
                        message: "Minimum reactions:",
                        default: "1",
                    });
                    minReactions = parseInt(n, 10);
                }
            }

            const showStats = await confirm({
                message: "Show comment statistics?",
                default: false,
            });

            const outputFormat = await select({
                message: "Output format:",
                choices: [
                    { value: "ai", name: "AI/Markdown (default)" },
                    { value: "json", name: "JSON" },
                ],
            });

            // Execute command
            const options = {
                comments: includeComments,
                limit,
                last,
                noBots,
                minReactions,
                stats: showStats,
                format: outputFormat as "ai" | "json",
            };

            if (action === "issue") {
                await issueCommand(urlInput, options);
            } else if (action === "pr") {
                await prCommand(urlInput, {
                    ...options,
                    reviewComments: await confirm({
                        message: "Include review comments?",
                        default: false,
                    }),
                });
            } else if (action === "comments") {
                await commentsCommand(urlInput, options);
            }

            // Continue?
            const continueSession = await confirm({
                message: "Continue with another query?",
                default: true,
            });

            if (!continueSession) {
                console.log(chalk.dim("Goodbye!"));
                break;
            }
        } catch (error) {
            if (error instanceof ExitPromptError) {
                console.log(chalk.dim("\nOperation cancelled."));
                break;
            }
            throw error;
        }
    }
}

// Main entry point
async function main(): Promise<void> {
    // If no arguments, run interactive mode
    if (process.argv.length <= 2) {
        try {
            await interactiveMode();
        } catch (error) {
            if (error instanceof ExitPromptError) {
                logger.info("User cancelled");
                process.exit(0);
            }
            throw error;
        } finally {
            closeDatabase();
        }
        return;
    }

    // Otherwise, parse command line
    try {
        await program.parseAsync();
    } catch (error) {
        logger.error({ error }, "Command failed");
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    } finally {
        closeDatabase();
    }
}

main();
