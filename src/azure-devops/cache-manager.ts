/**
 * Azure DevOps Cache Manager
 *
 * Domain-specific cache wrapper for timelog operations.
 * Wraps the generic Storage class with typed methods for
 * workitem, timelog, timetypes, teamMembers, and history caching.
 */

import type { TimeLogEntry } from "@app/azure-devops/types";
import { Storage } from "@app/utils/storage";

type CacheDomain = "workitem" | "timelog" | "timetypes" | "teamMembers" | "history";

const DOMAIN_TTLS: Record<CacheDomain, string> = {
    workitem: "365 days",
    timelog: "5 minutes",
    timetypes: "7 days",
    teamMembers: "30 days",
    history: "7 days",
};

export class AzureDevOpsCacheManager {
    private storage: Storage;

    constructor() {
        this.storage = new Storage("azure-devops");
    }

    // ============= Generic Cache Operations =============

    async get<T>(domain: CacheDomain, key: string, ttl?: string): Promise<T | null> {
        const effectiveTtl = ttl ?? DOMAIN_TTLS[domain];
        return this.storage.getCacheFile<T>(`${domain}/${key}.json`, effectiveTtl);
    }

    async set<T>(domain: CacheDomain, key: string, data: T, ttl?: string): Promise<void> {
        const effectiveTtl = ttl ?? DOMAIN_TTLS[domain];
        await this.storage.putCacheFile(`${domain}/${key}.json`, data, effectiveTtl);
    }

    async evict(domain: CacheDomain, key: string): Promise<void> {
        await this.storage.deleteCacheFile(`${domain}/${key}.json`);
    }

    // ============= Timelog-Specific (5-minute TTL) =============

    async getTimelogEntries(workItemId: number): Promise<TimeLogEntry[] | null> {
        return this.get<TimeLogEntry[]>("timelog", String(workItemId));
    }

    async setTimelogEntries(workItemId: number, entries: TimeLogEntry[]): Promise<void> {
        await this.set("timelog", String(workItemId), entries);
    }

    async evictTimelogForWorkitem(workItemId: number): Promise<void> {
        await this.evict("timelog", String(workItemId));
    }

    // ============= Eviction Triggers =============

    async onTimelogCreated(workItemIds: number[]): Promise<void> {
        for (const id of workItemIds) {
            await this.evictTimelogForWorkitem(id);
        }
    }
}
