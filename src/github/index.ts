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
import { logger, out } from "@app/logger";
import { enhanceHelp, runTool } from "@app/utils/cli";
import { checkAuth, getRateLimit } from "@app/utils/github/octokit";
import { detectRepoFromGit, parseGitHubUrl } from "@app/utils/github/url-parser";
import * as p from "@app/utils/prompts/p";
import { inquirerBackend as _inquirerBackend } from "@app/utils/prompts/p/inquirer-backend";

// Use inquirer backend for this tool
p.setBackend(_inquirerBackend);

import chalk from "chalk";
import { Command } from "commander";

const program = new Command();

program
    .name("github")
    .description("GitHub CLI tool for fetching issues, PRs, and comments")
    .version("1.0.0")
    .enablePositionalOptions();

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
        out.print(chalk.bold("GitHub Tool Status\n"));

        // Auth status
        out.print(chalk.underline("Authentication:"));
        const auth = await checkAuth();
        if (auth.authenticated) {
            out.print(chalk.green(`  ✔ Authenticated as @${auth.user}`));
            if (auth.scopes && auth.scopes.length > 0) {
                out.print(chalk.dim(`  Scopes: ${auth.scopes.join(", ")}`));
            }
        } else {
            out.print(chalk.yellow("  ✘ Not authenticated (limited access)"));
        }

        // Rate limit
        out.print(chalk.underline("\nRate Limit:"));
        try {
            const rateLimit = await getRateLimit();
            out.print(`  Remaining: ${rateLimit.remaining}/${rateLimit.limit}`);
            out.print(`  Resets: ${rateLimit.reset.toLocaleTimeString()}`);
        } catch {
            out.print(chalk.dim("  Could not fetch rate limit"));
        }

        // Cache stats
        out.print(chalk.underline("\nCache:"));
        const stats = getCacheStats();
        out.print(`  Repos: ${stats.repos}`);
        out.print(`  Issues/PRs: ${stats.issues}`);
        out.print(`  Comments: ${stats.comments}`);
        out.print(`  Events: ${stats.events}`);
    });

enhanceHelp(program);

// Interactive mode (no subcommand)
async function interactiveMode(): Promise<void> {
    out.print(chalk.bold.blue("🔧 GitHub Tool - Interactive Mode\n"));

    // Check auth first
    const auth = await checkAuth();
    if (auth.authenticated) {
        out.print(chalk.dim(`Authenticated as @${auth.user}\n`));
    } else {
        out.print(chalk.yellow("Not authenticated. Some features may be limited.\n"));
    }

    while (true) {
        const action = (await p.select({
            message: "What would you like to do?",
            options: [
                { value: "notifications", label: "🔔 Notifications" },
                { value: "activity", label: "📊 Activity Feed" },
                { value: "issue", label: "📋 Fetch Issue" },
                { value: "pr", label: "🔀 Fetch Pull Request" },
                { value: "review", label: "📝 Review PR Threads" },
                { value: "comments", label: "💬 Fetch Comments" },
                { value: "search", label: "🔍 Search Issues/PRs" },
                { value: "get", label: "📄 Get File Content" },
                { value: "status", label: "ℹ️  Show Status" },
                { value: "exit", label: "👋 Exit" },
            ],
        })) as string;

        if (action === "exit") {
            out.print(chalk.dim("Goodbye!"));
            break;
        }

        if (action === "status") {
            await program.commands.find((c) => c.name() === "status")?.parseAsync(["node", "github", "status"]);
            continue;
        }

        // Get input URL or search query
        let urlInput: string;

        if (action === "search") {
            urlInput = (await p.text({
                message: "Enter search query:",
            })) as string;

            if (!urlInput.trim()) {
                out.print(chalk.yellow("No query provided."));
                continue;
            }

            // Search options
            const typeFilter = (await p.select({
                message: "Filter by type:",
                options: [
                    { value: "all", label: "All" },
                    { value: "issue", label: "Issues only" },
                    { value: "pr", label: "PRs only" },
                ],
            })) as string;

            const stateFilter = (await p.select({
                message: "Filter by state:",
                options: [
                    { value: "all", label: "All" },
                    { value: "open", label: "Open only" },
                    { value: "closed", label: "Closed only" },
                ],
            })) as string;

            const limit = (await p.text({
                message: "Max results:",
                initialValue: "30",
            })) as string;

            await searchCommand(urlInput, {
                type: typeFilter as "issue" | "pr" | "all",
                state: stateFilter as "open" | "closed" | "all",
                limit: parseInt(limit, 10),
                format: "ai",
            });

            continue;
        }

        if (action === "review") {
            const prUrl = (await p.text({ message: "Enter PR number or URL:" })) as string;
            if (!prUrl.trim()) {
                out.print(chalk.yellow("No input provided."));
                continue;
            }
            const unresolvedOnly = await p.confirm({ message: "Show only unresolved?", initialValue: true });
            const groupByFile = await p.confirm({ message: "Group by file?", initialValue: true });
            const outputFormat = (await p.select({
                message: "Output format:",
                options: [
                    { value: "terminal", label: "Terminal (colorized)" },
                    { value: "md", label: "Markdown (save to file)" },
                    { value: "json", label: "JSON" },
                ],
            })) as string;
            await reviewCommand(prUrl, {
                unresolvedOnly,
                groupByFile,
                md: outputFormat === "md",
                json: outputFormat === "json",
            });
            continue;
        }

        if (action === "notifications") {
            const stateFilter = (await p.select({
                message: "Show notifications:",
                options: [
                    { value: "all", label: "All" },
                    { value: "unread", label: "Unread only" },
                    { value: "read", label: "Read only" },
                ],
            })) as string;

            const sinceFilter = (await p.select({
                message: "Time range:",
                options: [
                    { value: "", label: "All time" },
                    { value: "1d", label: "Last 24 hours" },
                    { value: "7d", label: "Last 7 days" },
                    { value: "30d", label: "Last 30 days" },
                ],
            })) as string;

            const repoFilter = (await p.text({
                message: "Filter by repo (owner/repo, or empty for all):",
            })) as string;

            await notificationsCommand({
                state: stateFilter as "read" | "unread" | "all",
                since: sinceFilter || undefined,
                repo: repoFilter.trim() || undefined,
                format: "ai",
            });

            continue;
        }

        if (action === "activity") {
            const sinceFilter = (await p.select({
                message: "Time range:",
                options: [
                    { value: "1d", label: "Last 24 hours" },
                    { value: "7d", label: "Last 7 days" },
                    { value: "30d", label: "Last 30 days" },
                ],
            })) as string;

            const typeFilter = (await p.select({
                message: "Event type:",
                options: [
                    { value: "", label: "All" },
                    { value: "push", label: "Pushes" },
                    { value: "pr", label: "Pull Requests" },
                    { value: "issue", label: "Issues" },
                    { value: "comment", label: "Comments" },
                ],
            })) as string;

            await activityCommand({
                since: sinceFilter || undefined,
                type: typeFilter || undefined,
                format: "ai",
            });
            continue;
        }

        if (action === "get") {
            const fileUrl = (await p.text({
                message: "Enter GitHub file URL:",
            })) as string;

            if (!fileUrl.trim()) {
                out.print(chalk.yellow("No URL provided."));
                continue;
            }

            const toClipboard = await p.confirm({
                message: "Copy to clipboard?",
                initialValue: false,
            });

            await getCommand(fileUrl, { clipboard: toClipboard });
            continue;
        }

        // Issue, PR, or Comments
        urlInput = (await p.text({
            message: "Enter URL or issue/PR number:",
        })) as string;

        if (!urlInput.trim()) {
            out.print(chalk.yellow("No input provided."));
            continue;
        }

        // Try to parse the URL
        const defaultRepo = (await detectRepoFromGit()) || undefined;
        const parsed = parseGitHubUrl(urlInput, defaultRepo);

        if (!parsed && !defaultRepo) {
            out.print(
                chalk.red("Could not parse input. Please provide a full GitHub URL or use --repo owner/repo option.")
            );
            continue;
        }

        // Common options
        const includeComments = await p.confirm({
            message: "Include comments?",
            initialValue: true,
        });

        let limit: number | undefined;
        let last: number | undefined;
        let noBots = false;
        let minReactions: number | undefined;

        if (includeComments) {
            const commentMode = (await p.select({
                message: "Comment selection:",
                options: [
                    { value: "limit", label: "Limit to N comments" },
                    { value: "last", label: "Last N comments" },
                    { value: "all", label: "All comments" },
                ],
            })) as string;

            if (commentMode === "limit" || commentMode === "last") {
                const n = (await p.text({
                    message: "How many comments?",
                    initialValue: "30",
                })) as string;
                if (commentMode === "limit") {
                    limit = parseInt(n, 10);
                } else {
                    last = parseInt(n, 10);
                }
            }

            noBots = !!(await p.confirm({
                message: "Exclude bot comments?",
                initialValue: false,
            }));

            const filterReactions = await p.confirm({
                message: "Filter by minimum reactions?",
                initialValue: false,
            });

            if (filterReactions) {
                const n = (await p.text({
                    message: "Minimum reactions:",
                    initialValue: "1",
                })) as string;
                minReactions = parseInt(n, 10);
            }
        }

        const showStats = await p.confirm({
            message: "Show comment statistics?",
            initialValue: false,
        });

        const outputFormat = (await p.select({
            message: "Output format:",
            options: [
                { value: "ai", label: "AI/Markdown (default)" },
                { value: "json", label: "JSON" },
            ],
        })) as string;

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
                reviewComments: !!(await p.confirm({
                    message: "Include review comments?",
                    initialValue: false,
                })),
            });
        } else if (action === "comments") {
            await commentsCommand(urlInput, options);
        }

        // Continue?
        const continueSession = await p.confirm({
            message: "Continue with another query?",
            initialValue: true,
        });

        if (!continueSession) {
            out.print(chalk.dim("Goodbye!"));
            break;
        }
    }
}

// Main entry point
async function main(): Promise<void> {
    // If no arguments, run interactive mode
    if (process.argv.length <= 2) {
        try {
            await interactiveMode();
        } finally {
            closeDatabase();
        }
        return;
    }

    // Otherwise, parse command line
    try {
        await runTool(program, { tool: "github" });
    } catch (error) {
        logger.error({ error }, "Command failed");
        out.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    } finally {
        closeDatabase();
    }
}

main();
