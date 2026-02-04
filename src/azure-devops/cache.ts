/**
 * Shared cache utilities for Azure DevOps CLI
 */
import { Storage } from "@app/utils/storage";

// Shared storage instance
export const storage = new Storage("azure-devops");

// Cache TTLs - different for each type
export const CACHE_TTL = {
  query: "180 days",
  workitem: "180 days",
  dashboard: "180 days",
  queries: "30 days",      // queries list cache
  project: "30 days",      // project metadata cache
} as const;

// Short TTL for workitem freshness check (in minutes)
export const WORKITEM_FRESHNESS_MINUTES = 5;

/**
 * Load data from global cache
 */
export async function loadGlobalCache<T>(
  type: "query" | "workitem" | "dashboard",
  id: string
): Promise<T | null> {
  await storage.ensureDirs();
  return storage.getCacheFile<T>(`${type}-${id}.json`, CACHE_TTL[type]);
}

/**
 * Save data to global cache
 */
export async function saveGlobalCache<T>(
  type: "query" | "workitem" | "dashboard",
  id: string,
  data: T
): Promise<void> {
  await storage.ensureDirs();
  await storage.putCacheFile(`${type}-${id}.json`, data, CACHE_TTL[type]);
}

/**
 * Format data as JSON
 */
export function formatJSON<T>(data: T): string {
  return JSON.stringify(data, null, 2);
}
