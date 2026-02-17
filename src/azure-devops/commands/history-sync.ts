/**
 * Azure DevOps CLI Tool - History Sync Command
 *
 * Bulk-syncs history for cached work items using either the batch reporting API
 * or per-item updates API.
 */

import { Api } from "@app/azure-devops/api";
import { isHistoryFresh, loadWorkItemCache, migrateHistoryCache, storage, updateWorkItemCacheSection } from "@app/azure-devops/cache";
import { buildHistoryFromRevisions, buildWorkItemHistory } from "@app/azure-devops/history";
import { requireConfig } from "@app/azure-devops/utils";

import logger from "@app/logger";
import * as p from "@clack/prompts";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import pc from "picocolors";

interface SyncOptions {
    force?: boolean;
    dryRun?: boolean;
    since?: string;
    batch?: boolean;
}

interface CachedWorkItem {
    id: number;
    title: string;
}

/**
 * Extract work item IDs and titles from cached workitem files in the storage cache directory.
 * Files are named `workitem-<id>.json`.
 */
function getCachedWorkItems(): CachedWorkItem[] {
    const cacheDir = storage.getCacheDir();
    let files: string[];
    try {
        files = readdirSync(cacheDir);
    } catch {
        return [];
    }

    const items: CachedWorkItem[] = [];
    for (const file of files) {
        const match = file.match(/^workitem-(\d+)\.json$/);
        if (match) {
            const id = parseInt(match[1], 10);
            let title = `#${id}`;
            try {
                const data = JSON.parse(readFileSync(join(cacheDir, file), "utf-8"));
                if (data.title) title = data.title;
            } catch {
                /* use fallback title */
            }
            items.push({ id, title });
        }
    }
    return items.sort((a, b) => a.id - b.id);
}

/**
 * Determine which work items need history sync.
 * If force is true, all items need sync. Otherwise, only those without existing history cache.
 */
async function getItemsNeedingSync(allItems: CachedWorkItem[], force: boolean): Promise<CachedWorkItem[]> {
    if (force) return allItems;

    const needSync: CachedWorkItem[] = [];
    for (const item of allItems) {
        const cached = await loadWorkItemCache(item.id);
        if (!cached || !isHistoryFresh(cached)) {
            needSync.push(item);
        }
    }
    return needSync;
}

/**
 * Bulk-sync history for cached work items.
 *
 * Two strategies:
 * - Batch mode (default): Uses reporting revisions API for efficient bulk fetch
 * - Per-item mode: Uses per-item updates API for precise delta data
 */
export async function handleHistorySync(options: SyncOptions): Promise<void> {
    const config = requireConfig();
    const api = new Api(config);

    // Migrate old history-*.json if any exist
    const migrated = await migrateHistoryCache();
    if (migrated > 0) p.log.info(`Migrated ${migrated} history files into workitem cache`);

    // Step 1: Find cached work item files
    const allItems = getCachedWorkItems();
    if (allItems.length === 0) {
        p.log.warn("No cached work items found. Run a query with --download-workitems first.");
        return;
    }
    p.log.info(`Found ${pc.bold(String(allItems.length))} cached work items`);

    // Step 2: Check which ones need sync
    const itemsToSync = await getItemsNeedingSync(allItems, options.force ?? false);
    if (itemsToSync.length === 0) {
        p.log.success("All work items already have history cached. Use --force to re-sync.");
        return;
    }

    // Default to per-item mode — batch (reporting API) scans entire project and is only
    // worthwhile for very large syncs. Per-item /updates is faster for typical counts.
    const usePerItem = !options.batch;
    const mode = usePerItem ? "per-item" : "batch";
    p.log.info(
        `${pc.bold(String(itemsToSync.length))} items need sync (${mode} mode)${options.force ? " [forced]" : ""}`
    );

    const titleMap = new Map(itemsToSync.map((item) => [item.id, item.title]));
    const shortTitle = (id: number) => {
        const t = titleMap.get(id) ?? `#${id}`;
        return t.length > 40 ? t.slice(0, 37) + "..." : t;
    };

    // Step 3: Dry run - just list what would be synced
    if (options.dryRun) {
        p.log.info("Dry run - would sync these work items:");
        for (const item of itemsToSync) {
            p.log.message(`  #${item.id} ${item.title}`);
        }
        return;
    }

    // Step 4: Sync
    const idsToSync = itemsToSync.map((item) => item.id);
    const spinner = p.spinner();

    if (usePerItem) {
        // Per-item mode: fetch updates for each item individually
        spinner.start(`Syncing history for ${idsToSync.length} items (per-item mode)`);
        let synced = 0;

        for (const id of idsToSync) {
            logger.debug(`[history-sync] Fetching updates for #${id}`);
            spinner.message(`${synced + 1}/${idsToSync.length} #${id} ${shortTitle(id)}`);
            const updates = await api.getWorkItemUpdates(id);
            const built = buildWorkItemHistory(updates);
            await updateWorkItemCacheSection(id, {
                history: {
                    updates: built.updates,
                    assignmentPeriods: built.assignmentPeriods,
                    statePeriods: built.statePeriods,
                },
            });
            synced++;
        }

        spinner.stop(`Synced history for ${synced} work items (per-item mode)`);
    } else {
        // Batch mode: use reporting revisions API
        const startDateTime = options.since ? new Date(options.since) : undefined;
        spinner.start(
            `Fetching reporting revisions for ${idsToSync.length} items${
                startDateTime ? ` since ${startDateTime.toISOString().slice(0, 10)}` : ""
            }`
        );

        const revisionsByItem = await api.getReportingRevisions({
            workItemIds: idsToSync,
            startDateTime,
            onProgress: ({ page, matchedItems, totalRevisions }) => {
                spinner.message(
                    `Page ${page}: ${totalRevisions} revisions scanned, ${matchedItems}/${idsToSync.length} items matched`
                );
            },
        });

        spinner.stop(`Received revisions for ${revisionsByItem.size} items (scanned all pages)`);

        // Build and save history for each item
        const saveSpinner = p.spinner();
        saveSpinner.start("Building and caching history");
        let saved = 0;

        for (const id of idsToSync) {
            const revisions = revisionsByItem.get(id) ?? [];
            if (revisions.length === 0) {
                logger.debug(`[history-sync] No revisions found for #${id}, skipping`);
                continue;
            }
            const built = buildHistoryFromRevisions(revisions);
            await updateWorkItemCacheSection(id, {
                history: {
                    updates: [],  // reporting revisions don't give us deltas
                    assignmentPeriods: built.assignmentPeriods,
                    statePeriods: built.statePeriods,
                },
            });
            saved++;
            saveSpinner.message(`Saved ${saved}/${idsToSync.length} #${id} ${shortTitle(id)}`);
        }

        saveSpinner.stop(`Saved history for ${saved} work items (batch mode)`);
    }

    p.log.success("History sync complete");
}
