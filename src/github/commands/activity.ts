// Activity command implementation

import { formatActivity } from "@app/github/lib/output";
import type { ActivityCommandOptions, ActivityItem, GitHubEvent } from "@app/github/types";
import logger from "@app/logger";
import { getOctokit } from "@app/utils/github/octokit";
import { withRetry } from "@app/utils/github/rate-limit";
import { parseDate } from "@app/utils/github/url-parser";
import { setGlobalVerbose, verbose } from "@app/utils/github/utils";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Summarize a GitHub event into a human-readable string
 */
function summarizeEvent(event: GitHubEvent): { summary: string; url: string | null } {
    const payload = event.payload;
    const repo = event.repo.name;

    switch (event.type) {
        case "PushEvent": {
            const commits = (payload.commits as Array<{ message: string }>) || [];
            const count = payload.size as number ?? commits.length;
            const ref = (payload.ref as string)?.replace("refs/heads/", "") || "unknown";
            const before = (payload.before as string)?.slice(0, 7);
            const head = (payload.head as string)?.slice(0, 7);
            const url = before && head
                ? `https://github.com/${repo}/compare/${before}...${head}`
                : `https://github.com/${repo}`;
            return {
                summary: `Pushed ${count} commit(s) to ${ref}`,
                url,
            };
        }
        case "CreateEvent":
            return {
                summary: `Created ${payload.ref_type as string}${payload.ref ? ` ${payload.ref as string}` : ""}`,
                url: `https://github.com/${repo}`,
            };
        case "DeleteEvent":
            return {
                summary: `Deleted ${payload.ref_type as string} ${payload.ref as string}`,
                url: `https://github.com/${repo}`,
            };
        case "IssuesEvent": {
            const issue = payload.issue as { number: number; title: string };
            return {
                summary: `${capitalizeFirst(payload.action as string)} issue #${issue.number}: ${issue.title}`,
                url: `https://github.com/${repo}/issues/${issue.number}`,
            };
        }
        case "IssueCommentEvent": {
            const issue = payload.issue as { number: number };
            return {
                summary: `Commented on #${issue.number}`,
                url: `https://github.com/${repo}/issues/${issue.number}`,
            };
        }
        case "PullRequestEvent": {
            const pr = payload.pull_request as { number: number; title?: string; merged?: boolean };
            const action = pr.merged ? "Merged" : capitalizeFirst(payload.action as string);
            const titlePart = pr.title ? `: ${pr.title}` : "";
            return {
                summary: `${action} PR #${pr.number}${titlePart}`,
                url: `https://github.com/${repo}/pull/${pr.number}`,
            };
        }
        case "PullRequestReviewEvent": {
            const pr = payload.pull_request as { number: number };
            return {
                summary: `Reviewed PR #${pr.number}`,
                url: `https://github.com/${repo}/pull/${pr.number}`,
            };
        }
        case "PullRequestReviewCommentEvent": {
            const pr = payload.pull_request as { number: number };
            return {
                summary: `Review comment on PR #${pr.number}`,
                url: `https://github.com/${repo}/pull/${pr.number}`,
            };
        }
        case "WatchEvent":
            return {
                summary: `Starred ${repo}`,
                url: `https://github.com/${repo}`,
            };
        case "ForkEvent":
            return {
                summary: `Forked ${repo}`,
                url: (payload.forkee as { html_url: string })?.html_url || `https://github.com/${repo}`,
            };
        case "ReleaseEvent": {
            const release = payload.release as { tag_name: string; html_url: string };
            return {
                summary: `${capitalizeFirst(payload.action as string)} release ${release.tag_name}`,
                url: release.html_url,
            };
        }
        default:
            return {
                summary: `${event.type.replace("Event", "")} on ${repo}`,
                url: `https://github.com/${repo}`,
            };
    }
}

function capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert raw GitHub event to simplified ActivityItem
 */
function toActivityItem(event: GitHubEvent): ActivityItem {
    const { summary, url } = summarizeEvent(event);
    return {
        id: event.id,
        type: event.type.replace("Event", ""),
        actor: event.actor.display_login || event.actor.login,
        repo: event.repo.name,
        summary,
        createdAt: event.created_at,
        url,
    };
}

/**
 * Main activity command handler
 */
export async function activityCommand(options: ActivityCommandOptions): Promise<void> {
    if (options.verbose) {
        setGlobalVerbose(true);
    }

    const octokit = getOctokit();

    // Determine user
    let user = options.user;
    if (!user) {
        // Get authenticated user
        const { data } = await withRetry(
            () => octokit.rest.users.getAuthenticated(),
            { label: "GET /user" },
        );
        user = data.login;
    }

    verbose(options, `Fetching activity for @${user} (received=${options.received ?? false})`);

    // Fetch events
    const endpoint = options.received
        ? "GET /users/{username}/received_events"
        : "GET /users/{username}/events";

    let allEvents: GitHubEvent[] = [];
    let page = 1;
    const limit = options.limit ?? 30;

    while (allEvents.length < limit) {
        const { data } = await withRetry(
            () =>
                octokit.request(endpoint, {
                    username: user,
                    per_page: Math.min(100, limit),
                    page,
                }),
            { label: `${endpoint.split(" ")[1]}?page=${page}` },
        );

        const events = data as GitHubEvent[];
        allEvents.push(...events);

        if (events.length < 100) break;
        page++;
        if (page > 5) break; // Safety: max 500 events
    }

    verbose(options, `Fetched ${allEvents.length} raw events`);

    // Convert to items
    let items = allEvents.map(toActivityItem);

    // Apply filters
    if (options.repo) {
        const repoFilter = options.repo.toLowerCase();
        items = items.filter((a) => a.repo.toLowerCase().includes(repoFilter));
    }

    if (options.type) {
        const types = options.type.split(",").map((t) => t.trim().toLowerCase());
        items = items.filter((a) => types.includes(a.type.toLowerCase()));
    }

    if (options.since) {
        const sinceDate = parseDate(options.since);
        if (sinceDate) {
            items = items.filter((a) => new Date(a.createdAt) >= sinceDate);
        }
    }

    // Apply limit
    items = items.slice(0, limit);

    if (items.length === 0) {
        console.log(chalk.yellow("No matching activity found."));
        return;
    }

    // Format output
    const format = options.format || "ai";
    const output = formatActivity(items, format);

    if (options.output) {
        await Bun.write(options.output, output);
        console.log(chalk.green(`Output written to ${options.output}`));
    } else {
        console.log(output);
    }
}

/**
 * Create activity command
 */
export function createActivityCommand(): Command {
    const cmd = new Command("activity")
        .description("View GitHub activity feed")
        .option("-u, --user <username>", "GitHub username (default: authenticated user)")
        .option("--received", "Show received events (activity from others)")
        .option("-r, --repo <repo>", "Filter by repository (partial match)")
        .option("--type <types>", "Filter by event type (Push,Issues,PullRequest,IssueComment,...)")
        .option("--since <date>", "Activity since date/time (e.g., 7d, 24h, 2025-01-01)")
        .option("-L, --limit <n>", "Max results", parseInt, 30)
        .option("-f, --format <format>", "Output format: ai|md|json", "ai")
        .option("-o, --output <file>", "Output path")
        .option("-v, --verbose", "Enable verbose logging")
        .action(async (opts) => {
            try {
                await activityCommand(opts);
            } catch (error) {
                logger.error({ error }, "Activity command failed");
                console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exit(1);
            }
        });

    return cmd;
}
