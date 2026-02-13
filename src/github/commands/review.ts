// Review command - fetch, display, reply to, and resolve PR review threads

import { formatReviewJSON, formatReviewMarkdown, formatReviewTerminal, saveReviewMarkdown } from "@app/github/lib/review-output";
import { calculateReviewStats, fetchPRReviewThreads, markThreadResolved, parseThreads, replyToThread } from "@app/github/lib/review-threads";
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
            '--thread-id is required when using --respond or --resolve-thread\n' +
            'Usage: tools github review <pr> --respond "message" -t <thread-id>\n' +
            '       tools github review <pr> --resolve-thread -t <thread-id>'
        );
    }

    // Handle respond and/or resolve operations
    if ((options.respond || resolveThreadOpt) && options.threadId) {
        if (options.respond) {
            console.error(chalk.dim(`Replying to thread ${options.threadId}...`));
            const replyId = await replyToThread(options.threadId, options.respond);
            console.log(chalk.green(`✓ Reply posted successfully! Reply ID: ${replyId}`));
        }

        if (resolveThreadOpt) {
            console.error(chalk.dim(`Resolving thread ${options.threadId}...`));
            const resolved = await markThreadResolved(options.threadId);
            if (resolved) {
                console.log(chalk.green(`✓ Thread resolved successfully!`));
            } else {
                throw new Error("Failed to resolve thread");
            }
        }

        return;
    }

    // Fetch PR review threads
    if (!options.json) {
        console.error(chalk.dim(`Fetching PR #${prNumber} from ${owner}/${repo}...`));
    }

    const prInfo = await fetchPRReviewThreads(owner, repo, prNumber);

    // Parse threads and compute stats on ALL threads
    const allThreads = parseThreads(prInfo.threads);
    const stats = calculateReviewStats(allThreads);

    // Filter if requested
    const displayThreads = options.unresolvedOnly
        ? allThreads.filter((t) => t.status === "unresolved")
        : allThreads;

    // Build review data
    const reviewData: ReviewData = {
        owner,
        repo,
        prNumber,
        title: prInfo.title,
        state: prInfo.state,
        threads: displayThreads,
        stats,
    };

    // JSON output
    if (options.json) {
        process.stdout.write(formatReviewJSON(reviewData) + "\n");
        return;
    }

    // Markdown output (save to file)
    if (options.md) {
        const mdContent = formatReviewMarkdown(reviewData, options.groupByFile ?? false);
        const filePath = saveReviewMarkdown(mdContent, prNumber);
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
  $ tools github review 137 --respond "fixed" --resolve-thread -t <thread-id>  # Reply AND resolve`
        )
        .argument("<pr>", "PR number or full GitHub URL")
        .option("-r, --repo <owner/repo>", "Repository (auto-detected from URL or git)")
        .option("-u, --unresolved-only", "Show only unresolved threads", false)
        .option("-g, --group-by-file", "Group threads by file path", false)
        .option("-m, --md", "Save output as markdown file to .claude/github/reviews/", false)
        .option("-j, --json", "Output as JSON", false)
        .option("--respond <message>", "Reply to a thread with this message")
        .option("-t, --thread-id <id>", "Thread ID for operations like reply/resolve")
        .option("-R, --resolve-thread", "Mark a thread as resolved", false)
        .option("--resolve", "Alias for --resolve-thread", false)
        .option("-v, --verbose", "Enable verbose logging")
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
