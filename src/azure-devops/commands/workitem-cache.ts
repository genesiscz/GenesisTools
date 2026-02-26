/**
 * Azure DevOps CLI Tool - Work Item Cache Command
 *
 * Handles the `list` command for listing cached work items
 * with their state and fetch time.
 */

import { CACHE_TTL, storage } from "@app/azure-devops/cache";
import type { WorkItemCache } from "@app/azure-devops/types";
import { findTaskFile, getRelativeTime } from "@app/azure-devops/utils";
import logger from "@app/logger";
import type { Command } from "commander";

/**
 * Handle the list command - display cached work items
 */
async function handleList(): Promise<void> {
    logger.debug("[list] Starting list command");
    const lines: string[] = [];
    lines.push("# Cached Work Items");
    lines.push("");

    logger.debug("[list] Scanning cache directory...");
    const cacheFiles = await storage.listCacheFiles(false);
    const workitemFiles = cacheFiles.filter((f) => f.startsWith("workitem-") && f.endsWith(".json"));
    logger.debug(`[list] Found ${workitemFiles.length} work item cache files`);

    if (workitemFiles.length === 0) {
        lines.push("No cached work items found.");
        console.log(lines.join("\n"));
        return;
    }

    const items: Array<{
        id: number;
        title: string;
        state: string;
        fetchedAt: Date;
        hasTask: boolean;
        hasHistory: boolean;
        hasComments: boolean;
    }> = [];

    for (const file of workitemFiles) {
        try {
            const cache = await storage.getCacheFile<WorkItemCache>(file, CACHE_TTL.workitem);
            if (cache) {
                const taskFile = findTaskFile(cache.id, "json");
                items.push({
                    id: cache.id,
                    title: cache.title,
                    state: cache.state,
                    fetchedAt: new Date(cache.cache?.fieldsFetchedAt ?? 0),
                    hasTask: taskFile !== null,
                    hasHistory: !!cache.cache?.historyFetchedAt,
                    hasComments: !!cache.cache?.commentsFetchedAt,
                });
            }
        } catch {
            /* ignore */
        }
    }

    items.sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());
    logger.debug(`[list] Loaded ${items.length} valid cache entries`);

    lines.push(`Found ${items.length} cached work items:`);
    lines.push("");
    lines.push("| ID | Title | State | Cached | File | Hist | Cmts |");
    lines.push("|-----|-------|-------|--------|------|------|------|");

    for (const item of items) {
        const title = item.title.length > 35 ? `${item.title.slice(0, 32)}...` : item.title;
        const age = getRelativeTime(item.fetchedAt);
        lines.push(
            `| ${item.id} | ${title} | ${item.state} | ${age} | ${item.hasTask ? "✓" : "✗"} | ${item.hasHistory ? "✓" : "✗"} | ${item.hasComments ? "✓" : "✗"} |`
        );
    }

    lines.push("");
    lines.push("To refresh a work item:");
    lines.push("  tools azure-devops --workitem <id> --force");

    console.log(lines.join("\n"));
}

/**
 * Register the workitem-cache command on the Commander program
 */
export function registerWorkitemCacheCommand(program: Command): void {
    program
        .command("list")
        .alias("ls")
        .description("List cached work items")
        .action(async () => {
            await handleList();
        });
}
