/**
 * Shared cache utilities for Azure DevOps CLI
 */

import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
    AssignmentPeriod,
    Comment,
    IdentityRef,
    StatePeriod,
    TimeType,
    WorkItemCache,
    WorkItemHistorySection,
    WorkItemUpdate,
} from "@app/azure-devops/types";
import { WORKITEM_CACHE_VERSION } from "@app/azure-devops/types";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";

// Shared storage instance
export const storage = new Storage("azure-devops");

// Cache TTLs - different for each type
export const CACHE_TTL = {
    query: "180 days",
    workitem: "365 days",
    dashboard: "180 days",
    queries: "30 days", // queries list cache
    project: "30 days", // project metadata cache
    timetypes: "7 days", // time types cache
    teamMembers: "30 days", // team members cache
    // history/comments TTL checked via isHistoryFresh()/isCommentsFresh() on cache.* timestamps
} as const;

// Short TTL for workitem freshness check (in minutes)
export const WORKITEM_FRESHNESS_MINUTES = 5;

/**
 * Load data from global cache
 */
export async function loadGlobalCache<T>(type: "query" | "workitem" | "dashboard", id: string): Promise<T | null> {
    await storage.ensureDirs();
    return storage.getCacheFile<T>(`${type}-${id}.json`, CACHE_TTL[type]);
}

/**
 * Save data to global cache
 */
export async function saveGlobalCache<T>(type: "query" | "workitem" | "dashboard", id: string, data: T): Promise<void> {
    await storage.ensureDirs();
    await storage.putCacheFile(`${type}-${id}.json`, data, CACHE_TTL[type]);
}

/**
 * Format data as JSON
 */
export function formatJSON<T>(data: T): string {
    return JSON.stringify(data, null, 2);
}

/**
 * Load time types from cache
 */
export async function loadTimeTypesCache(projectId: string): Promise<TimeType[] | null> {
    await storage.ensureDirs();
    return storage.getCacheFile<TimeType[]>(`timetypes-${projectId}.json`, CACHE_TTL.timetypes);
}

/**
 * Save time types to cache
 */
export async function saveTimeTypesCache(projectId: string, types: TimeType[]): Promise<void> {
    await storage.ensureDirs();
    await storage.putCacheFile(`timetypes-${projectId}.json`, types, CACHE_TTL.timetypes);
}

/**
 * Load team members from cache
 */
export async function loadTeamMembersCache(projectId: string): Promise<IdentityRef[] | null> {
    await storage.ensureDirs();
    return storage.getCacheFile<IdentityRef[]>(`team-members-${projectId}.json`, CACHE_TTL.teamMembers);
}

/**
 * Save team members to cache
 */
export async function saveTeamMembersCache(projectId: string, members: IdentityRef[]): Promise<void> {
    await storage.ensureDirs();
    await storage.putCacheFile(`team-members-${projectId}.json`, members, CACHE_TTL.teamMembers);
}

// ============= Workitem Cache Helpers =============

const SECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for history/comments

/** Load a workitem cache entry (uses 365-day file-level TTL). */
export async function loadWorkItemCache(id: number): Promise<WorkItemCache | null> {
    await storage.ensureDirs();
    return storage.getCacheFile<WorkItemCache>(`workitem-${id}.json`, CACHE_TTL.workitem);
}

/** Save the full workitem cache entry (always stamps version). */
export async function saveWorkItemCache(id: number, data: WorkItemCache): Promise<void> {
    await storage.ensureDirs();
    data.version = WORKITEM_CACHE_VERSION;
    await storage.putCacheFile(`workitem-${id}.json`, data, CACHE_TTL.workitem);
}

/**
 * Atomically update sections of a workitem cache entry.
 * Merges the update into the existing cache without clobbering other sections.
 * Also updates the relevant `cache.*FetchedAt` timestamp.
 */
export async function updateWorkItemCacheSection(
    id: number,
    update: {
        history?: WorkItemHistorySection;
        comments?: Comment[];
    }
): Promise<void> {
    await storage.ensureDirs();
    const now = new Date().toISOString();
    await storage.atomicUpdate<WorkItemCache>(`workitem-${id}.json`, (current) => {
        const base: WorkItemCache = current ?? {
            version: WORKITEM_CACHE_VERSION,
            cache: { fieldsFetchedAt: now },
            id,
            rev: 0,
            changed: "",
            title: `#${id}`,
            state: "Unknown",
        };

        // Ensure version + cache metadata exist (handles pre-migration entries)
        base.version = WORKITEM_CACHE_VERSION;
        if (!base.cache) {
            // Handle pre-migration entries that have fetchedAt at top level
            const legacyFetchedAt =
                "fetchedAt" in base ? String((base as unknown as { fetchedAt: string }).fetchedAt) : now;
            base.cache = { fieldsFetchedAt: legacyFetchedAt };
        }

        if (update.history !== undefined) {
            base.history = update.history;
            base.cache.historyFetchedAt = now;
        }
        if (update.comments !== undefined) {
            base.comments = update.comments;
            base.cache.commentsFetchedAt = now;
        }

        return base;
    });
}

/** Check if a workitem's history section is fresh (within 7-day TTL). */
export function isHistoryFresh(cache: WorkItemCache): boolean {
    const fetchedAt = cache.cache?.historyFetchedAt;
    if (!fetchedAt) {
        return false;
    }
    return Date.now() - new Date(fetchedAt).getTime() < SECTION_TTL_MS;
}

/** Check if a workitem's comments section is fresh (within 7-day TTL). */
export function isCommentsFresh(cache: WorkItemCache): boolean {
    const fetchedAt = cache.cache?.commentsFetchedAt;
    if (!fetchedAt) {
        return false;
    }
    return Date.now() - new Date(fetchedAt).getTime() < SECTION_TTL_MS;
}

/**
 * One-time migration: merge existing history-*.json files into workitem-*.json.
 * Safe to run multiple times — skips items already merged.
 * Deletes history-*.json files after successful merge.
 */
export async function migrateHistoryCache(): Promise<number> {
    const cacheDir = storage.getCacheDir();
    let historyFiles: string[];
    try {
        const files = readdirSync(cacheDir);
        historyFiles = files.filter((f) => f.startsWith("history-") && f.endsWith(".json"));
    } catch {
        return 0;
    }

    if (historyFiles.length === 0) {
        return 0;
    }

    let migrated = 0;
    for (const file of historyFiles) {
        const idMatch = file.match(/^history-(\d+)\.json$/);
        if (!idMatch) {
            continue;
        }

        const id = parseInt(idMatch[1], 10);
        try {
            const content = await Bun.file(join(cacheDir, file)).text();
            const oldHistory = JSON.parse(content) as {
                workItemId: number;
                updates: WorkItemUpdate[];
                fetchedAt: string;
                assignmentPeriods: AssignmentPeriod[];
                statePeriods: StatePeriod[];
            };

            await updateWorkItemCacheSection(id, {
                history: {
                    updates: oldHistory.updates,
                    assignmentPeriods: oldHistory.assignmentPeriods,
                    statePeriods: oldHistory.statePeriods,
                },
            });

            unlinkSync(join(cacheDir, file));
            migrated++;
        } catch (error) {
            logger.warn(`[cache] Failed to migrate history-${id}.json: ${error}`);
        }
    }

    return migrated;
}
