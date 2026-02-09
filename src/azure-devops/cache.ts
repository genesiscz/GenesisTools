/**
 * Shared cache utilities for Azure DevOps CLI
 */

import type { IdentityRef, TimeType, WorkItemHistory } from "@app/azure-devops/types";
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
    history: "7 days", // work item history cache
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

/**
 * Load work item history from cache
 */
export async function loadHistoryCache(id: number): Promise<WorkItemHistory | null> {
    await storage.ensureDirs();
    return storage.getCacheFile<WorkItemHistory>(`history-${id}.json`, CACHE_TTL.history);
}

/**
 * Save work item history to cache
 */
export async function saveHistoryCache(id: number, history: WorkItemHistory): Promise<void> {
    await storage.ensureDirs();
    await storage.putCacheFile(`history-${id}.json`, history, CACHE_TTL.history);
}
