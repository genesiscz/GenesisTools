// Output formatters for GitHub data

import { formatReviewMarkdown, formatReviewTerminal } from "@app/github/lib/review-output";
import type {
    ActivityItem,
    CommentData,
    CommentStats,
    GitHubReactions,
    IssueData,
    NotificationItem,
    PRData,
    RepoSearchResult,
    ReviewData,
    SearchResult,
} from "@app/github/types";
import { sumReactions } from "@app/utils/github/utils";

type OutputFormat = "ai" | "md" | "json";

interface FormatOptions {
    noIndex?: boolean;
    filePath?: string; // For AI format - where the full content was saved
}

interface IndexEntry {
    section: string;
    lines: string;
    dateRange?: string;
}

const COMMENTS_PER_INDEX_GROUP = 10;

/**
 * Format issue data for output
 */
export function formatIssue(data: IssueData, format: OutputFormat, options: FormatOptions = {}): string {
    switch (format) {
        case "json":
            return JSON.stringify(data, null, 2);
        case "ai":
            return formatIssueSummary(data, options);
        default:
            return formatIssueMarkdown(data, options);
    }
}

/**
 * Format PR data for output
 */
export function formatPR(data: PRData, format: OutputFormat, options: FormatOptions = {}): string {
    switch (format) {
        case "json":
            return JSON.stringify(data, null, 2);
        case "ai":
            return formatPRSummary(data, options);
        default:
            return formatPRMarkdown(data, options);
    }
}

/**
 * Format search results
 */
export function formatSearchResults(results: SearchResult[], format: OutputFormat): string {
    switch (format) {
        case "json":
            return JSON.stringify(results, null, 2);
        default:
            return formatSearchMarkdown(results);
    }
}

/**
 * Format repository search results
 */
export function formatRepoResults(repos: RepoSearchResult[], format: OutputFormat): string {
    switch (format) {
        case "json":
            return JSON.stringify(repos, null, 2);
        default:
            return formatRepoMarkdown(repos);
    }
}

function formatRepoMarkdown(repos: RepoSearchResult[]): string {
    const lines: string[] = [];
    lines.push(`Found ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`);
    lines.push("");

    for (const repo of repos) {
        const stars = formatStarCount(repo.stars);
        const forks = formatStarCount(repo.forks);
        const lang = repo.language ? ` · ${repo.language}` : "";
        const archived = repo.archived ? " [ARCHIVED]" : "";
        lines.push(`**${repo.name}**${archived} — ★${stars} forks:${forks}${lang}`);
        if (repo.description) {
            lines.push(`  ${repo.description}`);
        }
        if (repo.topics.length > 0) {
            lines.push(`  Topics: ${repo.topics.slice(0, 8).join(", ")}`);
        }
        lines.push(`  ${repo.url} · pushed ${formatDate(repo.pushedAt)}`);
        lines.push("");
    }

    return lines.join("\n");
}

function formatStarCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

// AI Summary formatters (condensed output for AI consumption)

function formatIssueSummary(data: IssueData, options: FormatOptions): string {
    const lines: string[] = [];
    const typeLabel = data.issue.pull_request ? "PR" : "Issue";

    // Title
    lines.push(`# ${typeLabel} #${data.issue.number}: ${data.issue.title}`);
    lines.push("");

    // File path if saved
    if (options.filePath) {
        lines.push(`**Full content saved to:** \`${options.filePath}\``);
        lines.push("");
    }

    // Quick metadata
    lines.push(
        `**Repo:** ${data.owner}/${data.repo} | **State:** ${data.issue.state} | **Author:** @${data.issue.user?.login || "unknown"}`
    );
    lines.push(`**Created:** ${formatDate(data.issue.created_at)} | **Updated:** ${formatDate(data.issue.updated_at)}`);
    if (data.issue.reactions) {
        const reactionStr = formatReactions(data.issue.reactions);
        if (reactionStr) {
            lines.push(`**Reactions:** ${reactionStr}`);
        }
    }
    lines.push("");

    // Index (always included in AI format)
    if (!options.noIndex) {
        const index = buildIndex(data);
        if (index.length > 0) {
            lines.push("## Index");
            lines.push("");
            lines.push("| Section | Lines | Date Range |");
            lines.push("|---------|-------|------------|");
            for (const entry of index) {
                lines.push(`| ${entry.section} | ${entry.lines} | ${entry.dateRange || "-"} |`);
            }
            lines.push("");
        }
    }

    // Statistics (always included in AI format)
    const stats = data.stats || calculateStats(data.comments, data.issue.comments);
    lines.push("## Statistics");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Total Comments | ${stats.total} |`);
    lines.push(`| Shown Comments | ${stats.shown} |`);
    lines.push(`| Unique Authors | ${stats.uniqueAuthors} |`);
    if (stats.authorBreakdown.length > 0) {
        const topAuthor = stats.authorBreakdown[0];
        lines.push(`| Most Active | @${topAuthor.author} (${topAuthor.count}) |`);
    }
    lines.push(`| Total Reactions | ${stats.totalReactions} |`);
    if (stats.botComments > 0) {
        lines.push(`| Bot Comments | ${stats.botComments} |`);
    }
    if (stats.dateRange.start && stats.dateRange.end) {
        lines.push(
            `| Date Range | ${formatDateShort(stats.dateRange.start)} → ${formatDateShort(stats.dateRange.end)} |`
        );
    }
    lines.push("");

    // Linked issues summary
    if (data.linkedIssues && data.linkedIssues.length > 0) {
        lines.push("## Linked Issues");
        lines.push("");
        for (const linked of data.linkedIssues) {
            lines.push(`- ${capitalizeFirst(linked.linkType)} #${linked.number} (${linked.state}): ${linked.title}`);
        }
        lines.push("");
    }

    lines.push(`_Fetched: ${formatDate(data.fetchedAt)}_`);

    return lines.join("\n");
}

function formatPRSummary(data: PRData, options: FormatOptions): string {
    // Start with issue summary
    let output = formatIssueSummary(data, options);

    // Add PR-specific stats
    if (data.pr) {
        const prStats: string[] = [];
        prStats.push("");
        prStats.push("## PR Details");
        prStats.push("");
        prStats.push(`- **Branch:** ${data.pr.head.ref} → ${data.pr.base.ref}`);
        prStats.push(`- **Changes:** +${data.pr.additions} -${data.pr.deletions} in ${data.pr.changed_files} files`);
        if (data.pr.draft) prStats.push("- **Status:** Draft");
        if (data.pr.merged)
            prStats.push(
                `- **Merged:** ${formatDate(data.pr.merged_at!)} by @${data.pr.merged_by?.login ?? "unknown"}`
            );
        prStats.push("");

        // Insert before _Fetched
        const fetchedIdx = output.lastIndexOf("_Fetched:");
        if (fetchedIdx > 0) {
            output = output.slice(0, fetchedIdx) + prStats.join("\n") + output.slice(fetchedIdx);
        }
    }

    // Add review threads if present
    if (data.reviewThreads && data.reviewThreads.length > 0 && data.reviewThreadStats) {
        const reviewData: ReviewData = {
            owner: data.owner,
            repo: data.repo,
            prNumber: data.pr.number,
            title: data.pr.title,
            state: data.pr.state,
            threads: data.reviewThreads,
            stats: data.reviewThreadStats,
        };
        const reviewSection = formatReviewTerminal(reviewData, true);
        const fetchedIdx = output.lastIndexOf("_Fetched:");
        if (fetchedIdx > 0) {
            output = `${output.slice(0, fetchedIdx)}\n${reviewSection}\n${output.slice(fetchedIdx)}`;
        } else {
            output += `\n${reviewSection}`;
        }
    }

    return output;
}

// Full Markdown formatters

function formatIssueMarkdown(data: IssueData, options: FormatOptions): string {
    const lines: string[] = [];

    // Header
    const typeLabel = data.issue.pull_request ? "PR" : "Issue";
    lines.push(`# ${typeLabel} #${data.issue.number}: ${data.issue.title}`);
    lines.push("");

    // GitHub URL
    const issueUrl = `https://github.com/${data.owner}/${data.repo}/${data.issue.pull_request ? "pull" : "issues"}/${data.issue.number}`;
    lines.push(`**URL:** [${issueUrl}](${issueUrl})`);

    // Metadata
    lines.push(`**Repository:** ${data.owner}/${data.repo}`);
    lines.push(`**State:** ${data.issue.state} | **Author:** @${data.issue.user?.login || "unknown"}`);
    lines.push(`**Created:** ${formatDate(data.issue.created_at)} | **Updated:** ${formatDate(data.issue.updated_at)}`);
    if (data.issue.reactions) {
        const reactionStr = formatReactions(data.issue.reactions);
        if (reactionStr) {
            lines.push(`**Reactions:** ${reactionStr}`);
        }
    }

    if (data.issue.labels.length > 0) {
        lines.push(`**Labels:** ${data.issue.labels.map((l) => l.name).join(", ")}`);
    }

    if (data.issue.assignees.length > 0) {
        lines.push(`**Assignees:** ${data.issue.assignees.map((a) => `@${a.login}`).join(", ")}`);
    }

    if (data.issue.milestone) {
        lines.push(`**Milestone:** ${data.issue.milestone.title}`);
    }

    lines.push("");

    // Index at top (after metadata)
    if (!options.noIndex) {
        const index = buildIndex(data);
        if (index.length > 0) {
            lines.push("## Index");
            lines.push("");
            lines.push("| Section | Lines | Date Range |");
            lines.push("|---------|-------|------------|");
            for (const entry of index) {
                lines.push(`| ${entry.section} | ${entry.lines} | ${entry.dateRange || "-"} |`);
            }
            lines.push("");
        }
    }

    lines.push("---");
    lines.push("");

    // Description
    lines.push("## Description");
    lines.push("");
    if (data.issue.body) {
        lines.push(data.issue.body);
    } else {
        const issueType = "pull_request" in data.issue ? "pr" : "issue";
        const hintCmd = `tools github ${issueType} https://github.com/${data.owner}/${data.repo}/${issueType === "pr" ? "pull" : "issues"}/${data.issue.number} --full`;
        lines.push(`_No description provided._ (Run \`${hintCmd}\` to fetch full details)`);
    }
    lines.push("");

    // Linked issues
    if (data.linkedIssues && data.linkedIssues.length > 0) {
        lines.push("---");
        lines.push("");
        lines.push("## Linked Issues");
        lines.push("");
        for (const linked of data.linkedIssues) {
            lines.push(`- ${capitalizeFirst(linked.linkType)} #${linked.number} (${linked.state}): ${linked.title}`);
        }
        lines.push("");
    }

    // Timeline events
    if (data.events.length > 0) {
        lines.push("---");
        lines.push("");
        lines.push(`## Timeline Events (${data.events.length})`);
        lines.push("");
        for (const event of data.events) {
            lines.push(`- ${formatDate(event.createdAt)} - @${event.actor} ${event.details}`);
        }
        lines.push("");
    }

    // Comments
    if (data.comments.length > 0) {
        lines.push("---");
        lines.push("");

        const totalComments = data.issue.comments || data.stats?.total || data.comments.length;
        const shownComments = data.comments.length;

        lines.push(`## Comments (${totalComments} total, showing ${shownComments})`);
        lines.push("");

        if (data.comments.length > 0) {
            const firstDate = data.comments[0].createdAt;
            const lastDate = data.comments[data.comments.length - 1].createdAt;
            lines.push(`**Date Range:** ${formatDate(firstDate)} → ${formatDate(lastDate)}`);
            lines.push("");
        }

        for (let i = 0; i < data.comments.length; i++) {
            const comment = data.comments[i];

            // Comment header with link
            const commentLink =
                comment.htmlUrl ||
                `https://github.com/${data.owner}/${data.repo}/issues/${data.issue.number}#issuecomment-${comment.id}`;
            lines.push(
                `### Comment ${i + 1} — @${comment.author} · [${formatDate(comment.createdAt)}](${commentLink})`
            );

            // Reactions
            const reactionStr = formatReactions(comment.reactions);
            if (reactionStr) {
                lines.push(reactionStr);
            }
            lines.push("");

            // Reply indicator
            if (comment.replyTo) {
                lines.push(`[replying to comment #${comment.replyTo}]`);
                lines.push("");
            }

            lines.push(comment.body);
            lines.push("");
        }
    }

    // Statistics
    if (data.stats) {
        lines.push("---");
        lines.push("");
        lines.push("## Statistics");
        lines.push("");
        lines.push("| Metric | Value |");
        lines.push("|--------|-------|");
        lines.push(`| Total Comments | ${data.stats.total} |`);
        lines.push(`| Shown Comments | ${data.stats.shown} |`);
        lines.push(`| Unique Authors | ${data.stats.uniqueAuthors} |`);

        if (data.stats.authorBreakdown.length > 0) {
            const topAuthor = data.stats.authorBreakdown[0];
            lines.push(`| Most Active | @${topAuthor.author} (${topAuthor.count} comments) |`);
        }

        lines.push(`| Total Reactions | ${data.stats.totalReactions} |`);

        if (data.stats.botComments > 0) {
            lines.push(`| Bot Comments | ${data.stats.botComments} (filtered) |`);
        }

        lines.push("");
    }

    // Footer
    lines.push("---");
    lines.push(`_Fetched: ${data.fetchedAt}${data.cacheCursor ? ` | Cache cursor: ${data.cacheCursor}` : ""}_`);

    return lines.join("\n");
}

function formatPRMarkdown(data: PRData, options: FormatOptions): string {
    // Start with base issue formatting
    let output = formatIssueMarkdown(data, options);

    // Insert PR-specific info after metadata
    const prInfo: string[] = [];

    if (data.pr) {
        prInfo.push("");
        prInfo.push(`**Branch:** ${data.pr.head.ref} → ${data.pr.base.ref}`);
        prInfo.push(`**Changes:** +${data.pr.additions} -${data.pr.deletions} in ${data.pr.changed_files} files`);

        if (data.pr.draft) {
            prInfo.push("**Status:** Draft");
        }

        if (data.pr.merged) {
            prInfo.push(`**Merged:** ${formatDate(data.pr.merged_at!)} by @${data.pr.merged_by?.login ?? "unknown"}`);
        }
    }

    // Insert after the first metadata block (before Index)
    const indexPoint = output.indexOf("\n## Index");
    if (indexPoint > 0) {
        output = output.slice(0, indexPoint) + prInfo.join("\n") + output.slice(indexPoint);
    }

    // Add review threads (GraphQL, threaded) if present
    if (data.reviewThreads && data.reviewThreads.length > 0 && data.reviewThreadStats) {
        const reviewData: ReviewData = {
            owner: data.owner,
            repo: data.repo,
            prNumber: data.pr.number,
            title: data.pr.title,
            state: data.pr.state,
            threads: data.reviewThreads,
            stats: data.reviewThreadStats,
        };
        let reviewMd = formatReviewMarkdown(reviewData, true);
        // Demote H1 to H2 when embedding inside the full PR output
        if (reviewMd.startsWith("# ")) {
            reviewMd = `#${reviewMd.slice(1)}`;
        }

        // Insert before Statistics
        const statsPoint = output.lastIndexOf("\n---\n\n## Statistics");
        if (statsPoint > 0) {
            output = `${output.slice(0, statsPoint)}\n---\n\n${reviewMd}${output.slice(statsPoint)}`;
        } else {
            const footerPoint = output.lastIndexOf("\n---\n_Fetched");
            if (footerPoint > 0) {
                output = `${output.slice(0, footerPoint)}\n---\n\n${reviewMd}${output.slice(footerPoint)}`;
            } else {
                output += `\n---\n\n${reviewMd}`;
            }
        }
    }

    // Add review comments (REST, flat list) if present
    if (data.reviewComments && data.reviewComments.length > 0) {
        const reviewSection: string[] = [];
        reviewSection.push("");
        reviewSection.push("---");
        reviewSection.push("");
        reviewSection.push(`## Review Comments (${data.reviewComments.length})`);
        reviewSection.push("");

        for (const comment of data.reviewComments) {
            reviewSection.push(`### ${comment.path}:${comment.line || "file"} — @${comment.author}`);
            reviewSection.push("```");
            reviewSection.push(comment.diffHunk.split("\n").slice(-3).join("\n"));
            reviewSection.push("```");
            reviewSection.push(comment.body);
            reviewSection.push("");
        }

        // Insert before Statistics
        const statsPoint = output.lastIndexOf("\n---\n\n## Statistics");
        if (statsPoint > 0) {
            output = output.slice(0, statsPoint) + reviewSection.join("\n") + output.slice(statsPoint);
        }
    }

    // Add diff if present
    if (data.diff) {
        const diffSection: string[] = [];
        diffSection.push("");
        diffSection.push("---");
        diffSection.push("");
        diffSection.push("## Diff");
        diffSection.push("");
        diffSection.push("```diff");
        diffSection.push(data.diff);
        diffSection.push("```");
        diffSection.push("");

        const footerPoint = output.lastIndexOf("\n---\n_Fetched");
        if (footerPoint > 0) {
            output = output.slice(0, footerPoint) + diffSection.join("\n") + output.slice(footerPoint);
        }
    }

    return output;
}

function formatSearchMarkdown(results: SearchResult[]): string {
    const lines: string[] = [];
    const hasSource = results.some((r) => r.source);

    lines.push(`# Search Results (${results.length})`);
    lines.push("");

    if (hasSource) {
        lines.push("| # | Type | Title | State | Author | Reactions | Repo | Src |");
        lines.push("|---|------|-------|-------|--------|-----------|------|-----|");
    } else {
        lines.push("| # | Type | Title | State | Author | Reactions | Repo |");
        lines.push("|---|------|-------|-------|--------|-----------|------|");
    }

    for (const result of results) {
        const typeIcon = result.type === "pr" ? "🔀" : "📋";
        const stateIcon = result.state === "open" ? "🟢" : "🔴";
        const reactionsCol = result.reactions > 0 ? String(result.reactions) : "-";
        const baseRow = `| [#${result.number}](${result.url}) | ${typeIcon} | ${result.title} | ${stateIcon} ${result.state} | @${result.author} | ${reactionsCol} | ${result.repo} |`;

        if (hasSource) {
            const sourceTag =
                result.source === "both"
                    ? "A+L"
                    : result.source === "advanced"
                      ? "A"
                      : result.source === "legacy"
                        ? "L"
                        : "";
            lines.push(`${baseRow} ${sourceTag} |`);
        } else {
            lines.push(baseRow);
        }
    }

    lines.push("");
    lines.push(`_Found ${results.length} results_`);

    return lines.join("\n");
}

// Notification and Activity formatters

export function formatNotifications(items: NotificationItem[], format: "ai" | "md" | "json"): string {
    if (format === "json") return JSON.stringify(items, null, 2);

    const lines: string[] = [];
    lines.push(`# Notifications (${items.length})\n`);

    if (items.length === 0) {
        lines.push("No notifications found.");
        return lines.join("\n");
    }

    const unreadCount = items.filter((i) => i.unread).length;
    const byReason = new Map<string, number>();
    for (const item of items) {
        byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
    }
    lines.push(`**Unread:** ${unreadCount} / ${items.length}`);
    lines.push(`**Reasons:** ${[...byReason.entries()].map(([r, c]) => `${r} (${c})`).join(", ")}\n`);

    lines.push("| # | State | Type | Title | Repo | Reason | Updated |");
    lines.push("|---|-------|------|-------|------|--------|---------|");

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const state = item.unread ? "●" : "○";
        const shortType = item.type === "PullRequest" ? "PR" : item.type;
        const num = item.number ? `#${item.number}` : "";
        const title = `[${item.title}](${item.webUrl}) ${num}`;
        const date = new Date(item.updatedAt).toLocaleDateString();
        lines.push(`| ${i + 1} | ${state} | ${shortType} | ${title} | ${item.repo} | ${item.reason} | ${date} |`);
    }

    return lines.join("\n");
}

export function formatActivity(items: ActivityItem[], format: "ai" | "md" | "json"): string {
    if (format === "json") return JSON.stringify(items, null, 2);

    const lines: string[] = [];
    lines.push(`# Activity Feed (${items.length})\n`);

    if (items.length === 0) {
        lines.push("No activity found.");
        return lines.join("\n");
    }

    lines.push("| # | Time | Actor | Type | Summary | Repo |");
    lines.push("|---|------|-------|------|---------|------|");

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const time = new Date(item.createdAt).toLocaleString();
        const summary = item.url ? `[${item.summary}](${item.url})` : item.summary;
        lines.push(`| ${i + 1} | ${time} | @${item.actor} | ${item.type} | ${summary} | ${item.repo} |`);
    }

    return lines.join("\n");
}

// Index building

function buildIndex(data: IssueData): IndexEntry[] {
    const index: IndexEntry[] = [];
    let lineOffset = 15; // Approximate header + metadata lines

    // Description
    const descLines = (data.issue.body?.split("\n").length || 1) + 3;
    index.push({
        section: "Description",
        lines: `${lineOffset}-${lineOffset + descLines}`,
        dateRange: formatDateShort(data.issue.created_at),
    });
    lineOffset += descLines + 2;

    // Linked issues
    if (data.linkedIssues && data.linkedIssues.length > 0) {
        const linkedLines = data.linkedIssues.length + 4;
        index.push({
            section: "Linked Issues",
            lines: `${lineOffset}-${lineOffset + linkedLines}`,
        });
        lineOffset += linkedLines + 2;
    }

    // Events
    if (data.events.length > 0) {
        const eventLines = data.events.length + 4;
        const firstEventDate = data.events[0]?.createdAt;
        const lastEventDate = data.events[data.events.length - 1]?.createdAt;
        index.push({
            section: "Timeline Events",
            lines: `${lineOffset}-${lineOffset + eventLines}`,
            dateRange:
                firstEventDate && lastEventDate
                    ? `${formatDateShort(firstEventDate)} → ${formatDateShort(lastEventDate)}`
                    : undefined,
        });
        lineOffset += eventLines + 2;
    }

    // Comments - grouped by COMMENTS_PER_INDEX_GROUP
    if (data.comments.length > 0) {
        const commentsStartLine = lineOffset;

        // Calculate approximate lines per comment (header + body avg)
        const avgLinesPerComment = 8;

        // Group comments
        for (let i = 0; i < data.comments.length; i += COMMENTS_PER_INDEX_GROUP) {
            const groupEnd = Math.min(i + COMMENTS_PER_INDEX_GROUP, data.comments.length);
            const groupComments = data.comments.slice(i, groupEnd);

            const groupStartLine = commentsStartLine + i * avgLinesPerComment;
            const groupEndLine = groupStartLine + (groupEnd - i) * avgLinesPerComment;

            const firstDate = groupComments[0].createdAt;
            const lastDate = groupComments[groupComments.length - 1].createdAt;

            const label =
                data.comments.length <= COMMENTS_PER_INDEX_GROUP ? "Comments" : `Comments ${i + 1}-${groupEnd}`;

            index.push({
                section: label,
                lines: `${groupStartLine}-${groupEndLine}`,
                dateRange: `${formatDateShort(firstDate)} → ${formatDateShort(lastDate)}`,
            });
        }
    }

    // Statistics
    if (data.stats) {
        index.push({
            section: "Statistics",
            lines: `end`,
        });
    }

    return index;
}

// Helper functions

function formatDate(dateStr: string): string {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toISOString().replace("T", " ").slice(0, 16);
}

function formatDateShort(dateStr: string): string {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "-";
    const day = date.getDate().toString().padStart(2, "0");
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const year = date.getFullYear();
    const hours = date.getHours().toString().padStart(2, "0");
    const mins = date.getMinutes().toString().padStart(2, "0");
    return `${day}.${month}.${year} ${hours}:${mins}`;
}

function formatReactions(reactions: GitHubReactions): string {
    if (!reactions || sumReactions(reactions) === 0) {
        return "";
    }

    const parts: string[] = [];
    const emojiMap: Record<string, string> = {
        "+1": "👍",
        "-1": "👎",
        laugh: "😄",
        hooray: "🎉",
        confused: "😕",
        heart: "❤️",
        rocket: "🚀",
        eyes: "👀",
    };

    for (const [key, emoji] of Object.entries(emojiMap)) {
        const count = reactions[key as keyof GitHubReactions];
        if (typeof count === "number" && count > 0) {
            parts.push(`${emoji} ${count}`);
        }
    }

    return parts.join(" · ");
}

function _truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
}

function capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Calculate comment statistics
 */
export function calculateStats(comments: CommentData[], totalInCache: number = 0): CommentStats {
    const authorCounts: Record<string, number> = {};
    const reactionCounts: Record<string, number> = {};
    let totalReactions = 0;
    let botComments = 0;

    for (const comment of comments) {
        // Author breakdown
        authorCounts[comment.author] = (authorCounts[comment.author] || 0) + 1;

        // Bot count
        if (comment.isBot) {
            botComments++;
        }

        // Reaction counts
        if (comment.reactions) {
            totalReactions += sumReactions(comment.reactions);
            for (const [key, value] of Object.entries(comment.reactions)) {
                if (key !== "total_count" && typeof value === "number") {
                    reactionCounts[key] = (reactionCounts[key] || 0) + value;
                }
            }
        }
    }

    const authorBreakdown = Object.entries(authorCounts)
        .map(([author, count]) => ({ author, count }))
        .sort((a, b) => b.count - a.count);

    return {
        total: totalInCache || comments.length,
        shown: comments.length,
        uniqueAuthors: Object.keys(authorCounts).length,
        authorBreakdown,
        totalReactions,
        reactionBreakdown: reactionCounts,
        botComments,
        dateRange: {
            start: comments[0]?.createdAt || "",
            end: comments[comments.length - 1]?.createdAt || "",
        },
    };
}
