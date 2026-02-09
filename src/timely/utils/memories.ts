import logger from "@app/logger";
import type { TimelyEntry } from "@app/timely/types";
import type { Storage } from "@app/utils/storage";

const CACHE_TTL = "30 days";

export interface FetchMemoriesOptions {
    accountId: number;
    accessToken: string;
    dates: string[];
    storage: Storage;
    verbose?: boolean;
    force?: boolean;
}

export interface FetchMemoriesResult {
    /** All memories across all dates */
    entries: TimelyEntry[];
    /** Memories grouped by date */
    byDate: Map<string, TimelyEntry[]>;
    /** Stats for verbose output */
    stats: { fetched: number; cached: number; failed: number };
}

/**
 * Fetch memories (suggested entries) for a list of dates with caching.
 * Today's date is always fetched fresh (memories can change throughout the day).
 * Past dates are cached for 30 days.
 */
export async function fetchMemoriesForDates(options: FetchMemoriesOptions): Promise<FetchMemoriesResult> {
    const { accountId, accessToken, dates, storage, verbose, force } = options;
    const today = new Date().toISOString().slice(0, 10);
    const sortedDates = [...dates].sort();

    if (verbose) logger.info(`[memories] Fetching memories for ${sortedDates.length} date(s) (today=${today})`);

    const entries: TimelyEntry[] = [];
    const byDate = new Map<string, TimelyEntry[]>();
    const stats = { fetched: 0, cached: 0, failed: 0 };

    for (let i = 0; i < sortedDates.length; i++) {
        const date = sortedDates[i];
        const isToday = date === today;
        const cacheKey = `memories/memories-${date}.json`;
        const progress = `${i + 1}/${sortedDates.length}`;

        try {
            let memories: TimelyEntry[];

            if (isToday || force) {
                memories = await fetchFromApi(accountId, accessToken, date);
                if (!isToday) await storage.putCacheFile(cacheKey, memories, CACHE_TTL);
                stats.fetched++;
                if (verbose)
                    logger.info(
                        `[memories] ${progress} ${date}: ${memories.length} memories (${isToday ? "fresh, today" : "force refresh"})`
                    );
            } else {
                const cached = await storage.getCacheFile<TimelyEntry[]>(cacheKey, CACHE_TTL);
                if (cached) {
                    memories = cached;
                    stats.cached++;
                    if (verbose) logger.info(`[memories] ${progress} ${date}: ${memories.length} memories (cached)`);
                } else {
                    memories = await fetchFromApi(accountId, accessToken, date);
                    await storage.putCacheFile(cacheKey, memories, CACHE_TTL);
                    stats.fetched++;
                    if (verbose) logger.info(`[memories] ${progress} ${date}: ${memories.length} memories (fetched)`);
                }
            }

            entries.push(...memories);
            byDate.set(date, memories);
        } catch (err) {
            stats.failed++;
            logger.debug(`[memories] Failed to fetch memories for ${date}: ${err}`);
            if (verbose) logger.info(`[memories] ${progress} ${date}: FAILED`);
        }
    }

    if (verbose) {
        logger.info(
            `[memories] Done: ${entries.length} total, ${stats.fetched} fetched, ${stats.cached} cached, ${stats.failed} failed`
        );
    }

    return { entries, byDate, stats };
}

async function fetchFromApi(accountId: number, accessToken: string, date: string): Promise<TimelyEntry[]> {
    const url = `https://app.timelyapp.com/${accountId}/suggested_entries.json?date=${date}&spam=true`;
    const res = await fetch(url, {
        headers: { accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as TimelyEntry[];
}

/**
 * Build a map from sub-entry IDs to their parent memory.
 * Used by events --with-entries to match event entry_ids to memories.
 */
export function buildSubEntryMap(memories: TimelyEntry[]): Map<number, TimelyEntry> {
    const map = new Map<number, TimelyEntry>();
    for (const memory of memories) {
        if (memory.entry_ids) {
            for (const subId of memory.entry_ids) {
                map.set(subId, memory);
            }
        }
    }
    return map;
}
