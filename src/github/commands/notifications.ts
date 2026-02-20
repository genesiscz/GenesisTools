// Notifications command implementation

import { formatNotifications } from "@app/github/lib/output";
import type { GitHubNotification, NotificationItem, NotificationsCommandOptions } from "@app/github/types";
import logger from "@app/logger";
import { Browser } from "@app/utils/browser";
import { getOctokit } from "@app/utils/github/octokit";
import { withRetry } from "@app/utils/github/rate-limit";
import { apiUrlToWebUrl, extractNumberFromApiUrl, parseDate } from "@app/utils/github/url-parser";
import { setGlobalVerbose, verbose } from "@app/utils/github/utils";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Convert raw GitHub notification to simplified NotificationItem
 */
function toNotificationItem(n: GitHubNotification): NotificationItem {
    const webUrl = apiUrlToWebUrl(n.subject.url, n.repository.html_url);
    const number = extractNumberFromApiUrl(n.subject.url);

    return {
        id: n.id,
        title: n.subject.title,
        repo: n.repository.full_name,
        reason: n.reason,
        type: n.subject.type,
        unread: n.unread,
        updatedAt: n.updated_at,
        webUrl,
        number,
    };
}

/**
 * Main notifications command handler
 */
export async function notificationsCommand(options: NotificationsCommandOptions): Promise<void> {
    if (options.verbose) {
        setGlobalVerbose(true);
    }

    const octokit = getOctokit();

    // Build request params
    const params: Record<string, string | boolean | number> = {
        per_page: 50,
    };

    if (options.participating) {
        params.participating = true;
    }

    if (options.state === "read") {
        params.all = true; // API needs 'all' to include read notifications
    } else if (options.state === "all") {
        params.all = true;
    }
    // Default: unread only (no 'all' param needed)

    // Since filter
    if (options.since) {
        const sinceDate = parseDate(options.since);
        if (sinceDate) {
            params.since = sinceDate.toISOString();
        }
    }

    verbose(options, `Fetching notifications with params: ${JSON.stringify(params)}`);

    // Fetch all pages
    const allNotifications: GitHubNotification[] = [];
    let page = 1;

    while (true) {
        const { data } = await withRetry(
            () =>
                octokit.request("GET /notifications", {
                    ...params,
                    page,
                    per_page: 50,
                }),
            { label: `GET /notifications?page=${page}` }
        );

        const notifications = data as GitHubNotification[];
        allNotifications.push(...notifications);

        if (notifications.length < 50) break;
        page++;
        if (page > 10) break; // Safety: max 500 notifications
    }

    verbose(options, `Fetched ${allNotifications.length} raw notifications`);

    // Convert to items
    let items = allNotifications.map(toNotificationItem);

    // Apply filters
    if (options.reason) {
        const reasons = options.reason.split(",").map((r) => r.trim());
        items = items.filter((n) => reasons.includes(n.reason));
    }

    if (options.repo) {
        const repoFilter = options.repo.toLowerCase();
        items = items.filter((n) => n.repo.toLowerCase().includes(repoFilter));
    }

    if (options.titleMatch) {
        const pattern = new RegExp(options.titleMatch, "i");
        items = items.filter((n) => pattern.test(n.title));
    }

    if (options.type) {
        const types = options.type.split(",").map((t) => t.trim());
        items = items.filter((n) => types.includes(n.type));
    }

    if (options.state === "read") {
        items = items.filter((n) => !n.unread);
    } else if (options.state === "unread") {
        items = items.filter((n) => n.unread);
    }

    // Apply limit
    const limit = options.limit ?? 50;
    items = items.slice(0, limit);

    if (items.length === 0) {
        console.log(chalk.yellow("No matching notifications found."));
        return;
    }

    console.log(chalk.dim(`Found ${items.length} matching notification(s)\n`));

    // Open in browser
    if (options.open) {
        const urls = items.map((n) => n.webUrl);
        console.log(chalk.cyan(`Opening ${urls.length} URL(s) in browser...\n`));
        const results = await Browser.openAll(urls);
        const failed = results.filter((r) => !r.success);
        if (failed.length > 0) {
            console.log(chalk.yellow(`${failed.length} URL(s) failed to open`));
        }
    }

    // Mark as read
    if (options.markRead) {
        for (const item of items) {
            await withRetry(
                () =>
                    octokit.request("PATCH /notifications/threads/{thread_id}", {
                        thread_id: parseInt(item.id, 10),
                    }),
                { label: `PATCH /notifications/threads/${item.id}` }
            );
        }
        console.log(chalk.green(`Marked ${items.length} notification(s) as read`));
    }

    // Mark as done
    if (options.markDone) {
        for (const item of items) {
            await withRetry(
                () =>
                    octokit.request("DELETE /notifications/threads/{thread_id}", {
                        thread_id: parseInt(item.id, 10),
                    }),
                { label: `DELETE /notifications/threads/${item.id}` }
            );
        }
        console.log(chalk.green(`Marked ${items.length} notification(s) as done`));
    }

    // Format output
    const format = options.format || "ai";
    const output = formatNotifications(items, format);

    if (options.output) {
        await Bun.write(options.output, output);
        console.log(chalk.green(`Output written to ${options.output}`));
    } else {
        console.log(output);
    }
}

/**
 * Create notifications command
 */
export function createNotificationsCommand(): Command {
    const cmd = new Command("notifications")
        .alias("notif")
        .description("View and manage GitHub notifications")
        .option("--reason <reasons>", "Filter by reason (comma-separated: mention,comment,review_requested,assign)")
        .option("-r, --repo <repo>", "Filter by repository (partial match)")
        .option("--title <pattern>", "Filter by title (regex)")
        .option("--since <date>", "Notifications since date/time (e.g., 7d, 24h, 2025-01-01)")
        .option("--type <types>", "Filter by subject type (Issue,PullRequest,Release,Discussion)")
        .option("--state <state>", "Filter: read|unread|all (default: unread)")
        .option("--participating", "Only participating notifications")
        .option("--open", "Open matching notifications in browser")
        .option("--mark-read", "Mark matching notifications as read")
        .option("--mark-done", "Mark matching notifications as done (removes from inbox)")
        .option("-L, --limit <n>", "Max results", parseInt, 50)
        .option("-f, --format <format>", "Output format: ai|md|json", "ai")
        .option("-o, --output <file>", "Output path")
        .option("-v, --verbose", "Enable verbose logging")
        .action(async (opts) => {
            try {
                await notificationsCommand({
                    ...opts,
                    titleMatch: opts.title,
                });
            } catch (error) {
                logger.error({ error }, "Notifications command failed");
                console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exit(1);
            }
        });

    return cmd;
}
