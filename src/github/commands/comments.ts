// Comments command - shorthand for fetching just comments

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
    getComments as getCachedComments,
    getDatabase,
    getFetchMetadata,
    getIssue,
    getLastNComments,
    getOrCreateRepo,
    updateFetchMetadata,
    upsertComments,
    upsertIssue,
} from "@app/github/lib/cache";
import { calculateStats, formatIssue } from "@app/github/lib/output";
import { findReplyTarget, processQuotes } from "@app/github/lib/quotes";
import type { CommentData, CommentRecord, GitHubComment, IssueData } from "@app/github/types";
import logger from "@app/logger";
import { getOctokit } from "@app/utils/github/octokit";
import { withRetry } from "@app/utils/github/rate-limit";
import { detectRepoFromGit, extractCommentId, parseGitHubUrl } from "@app/utils/github/url-parser";
import {
    fromCommentRecord,
    setGlobalVerbose,
    sumNegativeReactions,
    sumPositiveReactions,
    sumReactions,
    toCommentRecord,
    verbose,
} from "@app/utils/github/utils";
import chalk from "chalk";
import { Command } from "commander";

interface CommentsCommandOptions {
    repo?: string;
    since?: string;
    first?: number;
    last?: number;
    minReactions?: number;
    minReactionsPositive?: number;
    minReactionsNegative?: number;
    author?: string;
    noBots?: boolean;
    format?: "ai" | "md" | "json";
    output?: string;
    noIndex?: boolean;
    verbose?: boolean;
    full?: boolean;
    refresh?: boolean;
}

// Known bots
const KNOWN_BOTS = [
    "dependabot",
    "renovate",
    "github-actions",
    "vercel",
    "netlify",
    "codecov",
    "stale",
    "linear",
    "mergify",
    "semantic-release-bot",
    "greenkeeper",
    "snyk-bot",
];

function formatCacheDate(dateStr: string): string {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) {
        return dateStr;
    }
    return d.toISOString().replace("T", " ").slice(0, 16);
}

function isBot(username: string, userType?: string): boolean {
    if (userType === "Bot") {
        return true;
    }
    if (username.endsWith("[bot]")) {
        return true;
    }
    const lowerName = username.toLowerCase();
    return KNOWN_BOTS.some((bot) => lowerName.includes(bot));
}

/**
 * Convert GitHub comment to our format
 */
function toCommentData(comment: GitHubComment, previousComments: { id: number; body: string }[]): CommentData {
    const username = comment.user?.login || "unknown";
    const botFlag = isBot(username, comment.user?.type);

    const { processedBody } = processQuotes(comment.body);

    const firstQuoteMatch = comment.body.match(/^>\s*(.+)/m);
    let replyTo: number | undefined;
    if (firstQuoteMatch) {
        const target = findReplyTarget(firstQuoteMatch[1], previousComments);
        if (target) {
            replyTo = target;
        }
    }

    return {
        id: comment.id,
        nodeId: comment.node_id,
        author: username,
        body: processedBody,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        reactions: comment.reactions || {
            total_count: 0,
            "+1": 0,
            "-1": 0,
            laugh: 0,
            hooray: 0,
            confused: 0,
            heart: 0,
            rocket: 0,
            eyes: 0,
        },
        isBot: botFlag,
        htmlUrl: comment.html_url,
        replyTo,
    };
}

/**
 * Fetch comments from API
 */
async function fetchComments(
    owner: string,
    repo: string,
    number: number,
    options: {
        since?: string;
        sinceId?: number;
    } = {}
): Promise<GitHubComment[]> {
    const octokit = getOctokit();
    const allComments: GitHubComment[] = [];
    let page = 1;

    const MAX_COMMENT_PAGES = 100; // Safety limit: 10,000 comments max

    while (page <= MAX_COMMENT_PAGES) {
        const { data } = await withRetry(
            () =>
                octokit.rest.issues.listComments({
                    owner,
                    repo,
                    issue_number: number,
                    per_page: 100,
                    page,
                    since: options.since,
                }),
            { label: `GET /repos/${owner}/${repo}/issues/${number}/comments (page ${page})` }
        );

        // If we have a sinceId, filter to only comments after it
        let comments = data as GitHubComment[];
        if (options.sinceId) {
            const sinceIndex = comments.findIndex((c) => c.id === options.sinceId);
            if (sinceIndex !== -1) {
                comments = comments.slice(sinceIndex + 1);
            }
        }

        allComments.push(...comments);

        if (data.length < 100) {
            break;
        }
        page++;
    }

    return allComments;
}

/**
 * Main comments command handler
 */
export async function commentsCommand(input: string, options: CommentsCommandOptions): Promise<void> {
    // Set global verbose for HTTP request logging
    if (options.verbose) {
        setGlobalVerbose(true);
    }

    // Initialize database
    getDatabase();

    verbose(options, `Parsing input: ${input}`);

    // Parse input - may include comment ID
    const defaultRepo = options.repo || (await detectRepoFromGit()) || undefined;
    const parsed = parseGitHubUrl(input, defaultRepo);

    if (!parsed) {
        console.error(chalk.red("Invalid input. Please provide a GitHub issue/PR URL."));
        process.exit(1);
    }

    const { owner, repo, number, commentId } = parsed;
    verbose(options, `Parsed: owner=${owner}, repo=${repo}, number=${number}, commentId=${commentId || "none"}`);
    console.log(chalk.dim(`Fetching comments for ${owner}/${repo}#${number}...`));

    // Get or create repo and issue in cache
    const repoRecord = getOrCreateRepo(owner, repo);
    let issueRecord = getIssue(repoRecord.id, number);

    // If no issue record exists, create a minimal one
    if (!issueRecord) {
        verbose(options, "Creating minimal issue record for caching");
        upsertIssue({
            repo_id: repoRecord.id,
            number,
            type: "issue",
            title: `#${number}`,
            body: "",
            state: "unknown",
            author: "unknown",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            closed_at: null,
            last_fetched: new Date().toISOString(),
            last_comment_cursor: null,
        });
        const fetched = getIssue(repoRecord.id, number);
        if (!fetched) {
            throw new Error(`Issue #${number} not found in cache after insert`);
        }
        issueRecord = fetched;
    }

    const metadata = getFetchMetadata(issueRecord.id);

    // Determine since parameter
    let sinceId: number | undefined = commentId;
    if (options.since) {
        const extractedId = extractCommentId(options.since);
        if (extractedId) {
            sinceId = extractedId;
        }
    }

    // Determine fetch strategy:
    // - full: force complete refetch
    // - refresh / cache > 5 min old: incremental update
    // - fresh cache (< 5 min): use cache only
    // - no cache: full fetch
    const hasCache = !!metadata?.last_full_fetch;
    const shouldFullFetch = options.full || !hasCache;
    const cacheAgeMs = metadata?.last_incremental_fetch
        ? Date.now() - new Date(metadata.last_incremental_fetch).getTime()
        : Infinity;
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const shouldIncrementalFetch =
        !shouldFullFetch && hasCache && metadata?.last_comment_date && (options.refresh || cacheAgeMs > CACHE_TTL_MS);

    let comments: CommentData[] = [];
    let fetchedNew = 0;

    if (shouldFullFetch) {
        // Full fetch - get all comments
        verbose(options, `Full fetch: getting all comments${sinceId ? ` since ID ${sinceId}` : ""}...`);

        const apiComments = await fetchComments(owner, repo, number, {
            sinceId,
        });
        verbose(options, `Fetched ${apiComments.length} comments from API`);
        fetchedNew = apiComments.length;

        // Convert to our format
        const previousComments: { id: number; body: string }[] = [];
        for (const apiComment of apiComments) {
            const converted = toCommentData(apiComment, previousComments);
            comments.push(converted);
            previousComments.push({ id: apiComment.id, body: apiComment.body });
        }

        // Store in cache
        if (comments.length > 0) {
            verbose(options, `Caching ${comments.length} comments`);
            const records = comments.map((c) => toCommentRecord(c, issueRecord.id));
            upsertComments(records);

            updateFetchMetadata(issueRecord.id, {
                last_full_fetch: new Date().toISOString(),
                last_incremental_fetch: new Date().toISOString(),
                total_comments: comments.length,
                last_comment_date: comments[comments.length - 1].createdAt,
            });
        }
    } else if (shouldIncrementalFetch) {
        // Incremental fetch - get new comments since last fetch, merge with cache
        verbose(options, `Incremental fetch: getting comments since ${metadata.last_comment_date}`);

        const sinceDate = metadata.last_comment_date;
        if (!sinceDate) {
            throw new Error("Expected last_comment_date for incremental fetch");
        }

        const apiComments = await fetchComments(owner, repo, number, {
            since: sinceDate,
        });

        // Filter out comments we already have (GitHub's since is inclusive of updated comments)
        const existingIds = new Set(getCachedComments(issueRecord.id, { limit: 10000 }).map((c) => c.id));
        const newComments = apiComments.filter((c) => !existingIds.has(String(c.id)));

        verbose(options, `Fetched ${apiComments.length} from API, ${newComments.length} are new`);
        fetchedNew = newComments.length;

        // Convert and cache new comments
        if (newComments.length > 0) {
            const previousComments: { id: number; body: string }[] = [];
            const newCommentData: CommentData[] = [];
            for (const apiComment of newComments) {
                const converted = toCommentData(apiComment, previousComments);
                newCommentData.push(converted);
                previousComments.push({ id: apiComment.id, body: apiComment.body });
            }

            verbose(options, `Caching ${newCommentData.length} new comments`);
            const records = newCommentData.map((c) => toCommentRecord(c, issueRecord.id));
            upsertComments(records);

            // Update metadata
            const newTotal = (metadata.total_comments || 0) + newCommentData.length;
            updateFetchMetadata(issueRecord.id, {
                last_incremental_fetch: new Date().toISOString(),
                total_comments: newTotal,
                last_comment_date: newCommentData[newCommentData.length - 1].createdAt,
            });
        }

        // Now get all comments from cache
        verbose(options, "Retrieving all comments from cache");
        const cachedRecords = getCachedComments(issueRecord.id, { limit: 10000 });
        comments = cachedRecords.map(fromCommentRecord);
        verbose(options, `Retrieved ${comments.length} total comments from cache`);
    } else {
        // Use cache only (fresh enough)
        const lastFull = metadata?.last_full_fetch ? formatCacheDate(metadata.last_full_fetch) : "never";
        const lastIncr = metadata?.last_incremental_fetch ? formatCacheDate(metadata.last_incremental_fetch) : "never";
        const ageMin = Math.round(cacheAgeMs / 60000);
        console.log(
            chalk.dim(`Using cached comments (${ageMin}m old, last full: ${lastFull}, last update: ${lastIncr})`)
        );

        let cachedRecords: CommentRecord[];
        if (options.last) {
            cachedRecords = getLastNComments(issueRecord.id, options.last, {
                excludeBots: options.noBots,
                minReactions: options.minReactions,
                author: options.author,
            });
        } else {
            cachedRecords = getCachedComments(issueRecord.id, {
                limit: 10000,
                since: sinceId ? String(sinceId) : undefined,
                minReactions: options.minReactions,
                author: options.author,
                excludeBots: options.noBots,
            });
        }

        comments = cachedRecords.map(fromCommentRecord);
        verbose(options, `Retrieved ${comments.length} comments from cache`);
    }

    // Apply filters (for fresh/incremental data that wasn't filtered by cache query)
    if (shouldFullFetch || shouldIncrementalFetch) {
        if (options.noBots) {
            comments = comments.filter((c) => !c.isBot);
        }

        if (options.minReactions !== undefined) {
            const min = options.minReactions;
            comments = comments.filter((c) => sumReactions(c.reactions) >= min);
        }
        if (options.minReactionsPositive !== undefined) {
            const min = options.minReactionsPositive;
            comments = comments.filter((c) => sumPositiveReactions(c.reactions) >= min);
        }
        if (options.minReactionsNegative !== undefined) {
            const min = options.minReactionsNegative;
            comments = comments.filter((c) => sumNegativeReactions(c.reactions) >= min);
        }

        if (options.author) {
            comments = comments.filter((c) => c.author.toLowerCase() === options.author?.toLowerCase());
        }
    }

    // Validate --first and --last mutual exclusivity
    if (options.first && options.last) {
        console.error(chalk.red("Error: Cannot specify both --first and --last. Use one or the other."));
        process.exit(1);
    }

    // Apply --first or --last
    if (options.first && options.first < comments.length) {
        comments = comments.slice(0, options.first);
    } else if (options.last && options.last < comments.length) {
        comments = comments.slice(-options.last);
    }

    // Build minimal output data
    const totalComments = metadata?.total_comments || comments.length;
    const stats = calculateStats(comments, totalComments);

    const outputData: IssueData = {
        owner,
        repo,
        issue: {
            id: 0,
            node_id: "",
            number,
            title: `Comments for #${number}`,
            body: null,
            state: "open",
            user: null,
            created_at: "",
            updated_at: "",
            closed_at: null,
            labels: [],
            assignees: [],
            milestone: null,
            comments: totalComments,
        },
        comments,
        events: [],
        stats,
        fetchedAt: new Date().toISOString(),
        cacheCursor: metadata?.last_comment_date || undefined,
    };

    // Format output
    const format = options.format || "ai";
    verbose(options, `Output format: ${format}`);

    if (format === "ai" && !options.output) {
        // Auto-save full MD content so AI index line numbers reference an actual file
        const localDir = join(process.cwd(), ".claude", "github");
        if (!existsSync(localDir)) {
            mkdirSync(localDir, { recursive: true });
        }
        const filename = join(localDir, `${owner}-${repo}-${number}-comments.md`);
        const fullContent = formatIssue(outputData, "md", { noIndex: options.noIndex });
        await Bun.write(filename, fullContent);
        verbose(options, `Full content saved to: ${filename}`);

        const summary = formatIssue(outputData, "ai", { noIndex: options.noIndex, filePath: filename });
        console.log(summary);
    } else {
        const output = formatIssue(outputData, format, { noIndex: options.noIndex });
        if (options.output) {
            await Bun.write(options.output, output);
            console.log(chalk.green(`✔ Output written to ${options.output}`));
        } else {
            console.log(output);
        }
    }
    verbose(options, `Completed: ${comments.length} comments`);

    // Build status message
    let cacheStatus: string;
    if (shouldFullFetch) {
        cacheStatus = `(full fetch, ${fetchedNew} comments)`;
    } else if (shouldIncrementalFetch) {
        const updatedMeta = getFetchMetadata(issueRecord.id);
        const lastUpdate = updatedMeta?.last_incremental_fetch
            ? formatCacheDate(updatedMeta.last_incremental_fetch)
            : "now";
        cacheStatus =
            fetchedNew > 0 ? `(+${fetchedNew} new, updated ${lastUpdate})` : `(up to date, last update: ${lastUpdate})`;
    } else {
        const ageMin = Math.round(cacheAgeMs / 60000);
        cacheStatus = `(cached, ${ageMin}m old)`;
    }
    console.log(
        chalk.dim(
            `\nFetched: ${comments.length} comments ${cacheStatus}${sinceId ? ` (since comment ${sinceId})` : ""}`
        )
    );
}

/**
 * Create comments command
 */
export function createCommentsCommand(): Command {
    const cmd = new Command("comments")
        .description("Fetch just comments from a GitHub issue/PR")
        .argument("<url>", "Issue/PR URL (may include #issuecomment-XXX)")
        .option("-r, --repo <owner/repo>", "Repository")
        .option("--since <id|url>", "Start from specific comment")
        .option("--first <n>", "First N comments", parseInt)
        .option("--last <n>", "Last N comments", parseInt)
        .option("--min-reactions <n>", "Min total reactions", parseInt)
        .option("--min-reactions-positive <n>", "Min positive reactions", parseInt)
        .option("--min-reactions-negative <n>", "Min negative reactions", parseInt)
        .option("--author <user>", "Filter by author")
        .option("--no-bots", "Exclude bots")
        .option("--full", "Force full refetch (ignore cache)")
        .option("--refresh", "Update cache with new data")
        .option("-f, --format <format>", "Output format: ai|md|json", "ai")
        .option("-o, --output <file>", "Output path")
        .option("--no-index", "Exclude index from output")
        .option("-v, --verbose", "Enable verbose logging")
        .action(async (url, opts) => {
            try {
                await commentsCommand(url, opts);
            } catch (error) {
                logger.error({ error }, "Comments command failed");
                console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exit(1);
            }
        });

    return cmd;
}
