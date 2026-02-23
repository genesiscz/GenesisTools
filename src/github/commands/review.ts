// Review command - fetch, display, reply to, and resolve PR review threads

import {
    formatReviewJSON,
    formatReviewMarkdown,
    formatReviewTerminal,
    saveReviewMarkdown,
} from "@app/github/lib/review-output";
import {
    batchReply,
    batchReplyAndResolve,
    batchResolveThreads,
    calculateReviewStats,
    fetchPRReviewThreads,
    parseThreads,
} from "@app/github/lib/review-threads";
import type { ReviewCommandOptions, ReviewData } from "@app/github/types";
import logger from "@app/logger";
import { detectRepoFromGit, parseGitHubUrl } from "@app/utils/github/url-parser";
import { setGlobalVerbose } from "@app/utils/github/utils";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Main review command handler
 */
export async function reviewCommand(input: string, options: ReviewCommandOptions): Promise<void> {
    // Set global verbose for HTTP request logging
    if (options.verbose) {
        setGlobalVerbose(true);
    }

    // Parse input
    const defaultRepo = options.repo || (await detectRepoFromGit()) || undefined;
    const parsed = parseGitHubUrl(input, defaultRepo);

    if (!parsed) {
        throw new Error("Invalid input. Please provide a GitHub PR URL or number.");
    }

    const { owner, repo, number: prNumber } = parsed;

    // Validate thread-id is provided when respond or resolve operations are requested
    const resolveThreadOpt = options.resolveThread || options.resolve;
    if ((options.respond || resolveThreadOpt) && !options.threadId) {
        throw new Error(
            "--thread-id is required when using --respond or --resolve-thread\n" +
                'Usage: tools github review <pr> --respond "message" -t <thread-id>\n' +
                "       tools github review <pr> --resolve-thread -t <thread-id>"
        );
    }

    // Handle respond and/or resolve operations (supports comma-separated thread IDs)
    if ((options.respond || resolveThreadOpt) && options.threadId) {
        const threadIds = options.threadId
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (threadIds.length === 0) {
            throw new Error("No valid thread IDs provided. Check your --thread-id value.");
        }
        const showProgress = threadIds.length > 1;

        if (options.respond && resolveThreadOpt) {
            const result = await batchReplyAndResolve(threadIds, options.respond, {
                onProgress: showProgress
                    ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`))
                    : undefined,
            });
            if (result.replied === 0 && result.failed.length > 0) {
                throw new Error(
                    `Failed to reply to or resolve any of ${result.failed.length} thread(s): ${result.failed.join(", ")}`
                );
            }
            console.log(chalk.green(`Replied to ${result.replied}, resolved ${result.resolved} thread(s)`));
            if (result.failed.length) {
                console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
            }
        } else if (resolveThreadOpt) {
            const result = await batchResolveThreads(threadIds, {
                onProgress: showProgress
                    ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`))
                    : undefined,
            });
            if (result.resolved === 0 && result.failed.length > 0) {
                throw new Error(
                    `Failed to resolve any of ${result.failed.length} thread(s): ${result.failed.join(", ")}`
                );
            }
            console.log(chalk.green(`Resolved ${result.resolved} thread(s)`));
            if (result.failed.length) {
                console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
            }
        } else {
            const result = await batchReply(threadIds, options.respond!, {
                onProgress: showProgress
                    ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`))
                    : undefined,
            });
            if (result.replied === 0 && result.failed.length > 0) {
                throw new Error(
                    `Failed to reply to any of ${result.failed.length} thread(s): ${result.failed.join(", ")}`
                );
            }
            console.log(chalk.green(`Replied to ${result.replied} thread(s)`));
            if (result.failed.length) {
                console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
            }
        }

        return;
    }

    // Fetch PR review threads
    if (!options.json) {
        console.error(chalk.dim(`Fetching PR #${prNumber} from ${owner}/${repo}...`));
    }

    const prInfo = await fetchPRReviewThreads(owner, repo, prNumber);

    // Parse threads, apply author filter, then compute stats
    const allThreads = parseThreads(prInfo.threads);
    const authorLogin = options.author?.toLowerCase();
    const authorFilteredThreads = authorLogin
        ? allThreads.filter((t) => t.author.toLowerCase() === authorLogin)
        : allThreads;
    const stats = calculateReviewStats(authorFilteredThreads);

    // Filter by resolution status if requested
    const displayThreads = options.unresolvedOnly
        ? authorFilteredThreads.filter((t) => t.status === "unresolved")
        : authorFilteredThreads;

    // Build review data
    const reviewData: ReviewData = {
        owner,
        repo,
        prNumber,
        title: prInfo.title,
        state: prInfo.state,
        threads: displayThreads,
        stats,
        prComments: options.prComments !== false
            ? (authorLogin
                ? prInfo.prComments?.filter((c) => c.author.toLowerCase() === authorLogin)
                : prInfo.prComments)
            : undefined,
    };

    // JSON output
    if (options.json) {
        process.stdout.write(`${formatReviewJSON(reviewData)}\n`);
        return;
    }

    // Markdown output (save to file)
    if (options.md) {
        const mdContent = formatReviewMarkdown(reviewData, options.groupByFile ?? false);
        const filePath = await saveReviewMarkdown(mdContent, prNumber);
        console.log(filePath);
        return;
    }

    // Terminal output (default)
    console.log(formatReviewTerminal(reviewData, options.groupByFile ?? false));
}

/**
 * Create review command for commander
 */
export function createReviewCommand(): Command {
    const cmd = new Command("review")
        .description(
            `Fetch and display GitHub PR review threads

Examples:
  $ tools github review 137                                              # Show review threads for PR #137
  $ tools github review https://github.com/owner/repo/pull/137           # Show review threads from URL
  $ tools github review 137 -u                                           # Show only unresolved threads
  $ tools github review 137 --json                                       # Output as JSON
  $ tools github review 137 --md -g                                      # Save as grouped markdown file
  $ tools github review 137 --respond "ok" -t <thread-id>                # Reply to a thread
  $ tools github review 137 --resolve-thread -t <thread-id>              # Mark a thread as resolved
  $ tools github review 137 --respond "fixed" --resolve-thread -t <thread-id>  # Reply AND resolve

  Batch operations (comma-separated thread IDs):
  $ tools github review 137 --resolve-thread -t id1,id2,id3              # Resolve multiple threads
  $ tools github review 137 --respond "Fixed" -t id1,id2                 # Reply to multiple threads
  $ tools github review 137 --respond "Fixed" --resolve-thread -t id1,id2,id3  # Reply+resolve batch`
        )
        .argument("<pr>", "PR number or full GitHub URL")
        .option("--repo <owner/repo>", "Repository (auto-detected from URL or git)")
        .option("-u, --unresolved-only", "Show only unresolved threads", false)
        .option("-g, --group-by-file", "Group threads by file path", false)
        .option("-m, --md", "Save output as markdown file to .claude/github/reviews/", false)
        .option("-j, --json", "Output as JSON", false)
        .option("-r, --respond <message>", "Reply to a thread with this message")
        .option("-t, --thread-id <ids>", "Thread ID(s) for reply/resolve (comma-separated for batch)")
        .option("-R, --resolve-thread", "Mark a thread as resolved", false)
        .option("--resolve", "Alias for --resolve-thread", false)
        .option("-v, --verbose", "Enable verbose logging")
        .option("--no-pr-comments", "Hide PR-level review summaries and conversation comments")
        .option("-a, --author <login>", "Filter threads by reviewer login (case-insensitive)")
        .action(async (input, opts) => {
            try {
                await reviewCommand(input, opts);
            } catch (error) {
                logger.error({ error }, "Review command failed");
                console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exit(1);
            }
        });

    return cmd;
}
