import { isTimelyAuthFailure } from "@app/timely/api/errors";
import { fetchTimelyWebJson } from "@app/timely/api/web-fetch";
import type { TimelyEntry } from "@app/timely/types";
import { readStoredCookie } from "@app/timely/utils/cookie";
import { logger } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";

const CACHE_TTL = "30 days";

export interface FetchMemoriesOptions {
    accountId: number;
    accessToken: string;
    dates: string[];
    storage: Storage;
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
    const { accountId, accessToken, dates, storage, force } = options;
    const today = new Date().toISOString().slice(0, 10);
    const sortedDates = [...dates].sort();

    // app.timelyapp.com only honours the browser session cookie; the bearer alone 401s.
    const cookie = await readStoredCookie(storage);

    logger.debug(
        `[memories] Fetching memories for ${sortedDates.length} date(s) (today=${today}, browser cookie ${cookie ? "present" : "absent"})`
    );

    const entries: TimelyEntry[] = [];
    const byDate = new Map<string, TimelyEntry[]>();
    const stats = { fetched: 0, cached: 0, failed: 0 };
    const failedDates: string[] = [];

    for (let i = 0; i < sortedDates.length; i++) {
        const date = sortedDates[i];
        const isToday = date === today;
        const cacheKey = `memories/memories-${date}.json`;
        const progress = `${i + 1}/${sortedDates.length}`;

        try {
            let memories: TimelyEntry[];

            if (isToday || force) {
                memories = await fetchFromApi({ accountId, accessToken, cookie, date });
                if (!isToday) {
                    await storage.putCacheFile(cacheKey, memories, CACHE_TTL);
                }
                stats.fetched++;
                logger.debug(
                    `[memories] ${progress} ${date}: ${memories.length} memories (${isToday ? "fresh, today" : "force refresh"})`
                );
            } else {
                const cached = await storage.getCacheFile<TimelyEntry[]>(cacheKey, CACHE_TTL);
                if (cached) {
                    memories = cached;
                    stats.cached++;
                    logger.debug(`[memories] ${progress} ${date}: ${memories.length} memories (cached)`);
                } else {
                    memories = await fetchFromApi({ accountId, accessToken, cookie, date });
                    await storage.putCacheFile(cacheKey, memories, CACHE_TTL);
                    stats.fetched++;
                    logger.debug(`[memories] ${progress} ${date}: ${memories.length} memories (fetched)`);
                }
            }

            entries.push(...memories);
            byDate.set(date, memories);
        } catch (err) {
            if (isTimelyAuthFailure(err)) {
                // Credentials, not this date: every remaining date fails identically.
                // Let the caller report it instead of returning a misleading empty list.
                logger.debug(`[memories] ${progress} ${date}: auth failure, aborting the run`);
                throw err;
            }

            stats.failed++;
            failedDates.push(date);
            logger.error(
                `[memories] ${progress} ${date}: FAILED - ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    if (stats.failed > 0) {
        logger.warn(
            `[memories] ${stats.failed} of ${sortedDates.length} date(s) could not be fetched (${failedDates.join(", ")}); the totals below are incomplete.`
        );
    }

    logger.debug(
        `[memories] Done: ${entries.length} total, ${stats.fetched} fetched, ${stats.cached} cached, ${stats.failed} failed`
    );

    return { entries, byDate, stats };
}

async function fetchFromApi(options: {
    accountId: number;
    accessToken: string;
    cookie?: string;
    date: string;
}): Promise<TimelyEntry[]> {
    const { accountId, accessToken, cookie, date } = options;
    const url = `https://app.timelyapp.com/${accountId}/suggested_entries.json?date=${date}&spam=true`;

    return (await fetchTimelyWebJson({
        url,
        accessToken,
        cookie,
        scope: "memories",
        label: `Memories request for ${date}`,
    })) as TimelyEntry[];
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
