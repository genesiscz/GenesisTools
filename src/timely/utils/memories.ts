import { isTimelyAuthFailure } from "@app/timely/api/errors";
import { fetchTimelyWebJson } from "@app/timely/api/web-fetch";
import type { TimelyEntry } from "@app/timely/types";
import { readStoredCookie } from "@app/timely/utils/cookie";
import { logger } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";
import { timelyAccountCacheKey } from "./account-cache";

const CACHE_TTL = "30 days";
const MEMORIES_FETCH_CONCURRENCY = 3;

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
    const results: Array<TimelyEntry[] | undefined> = new Array(sortedDates.length);
    const fetchIndexes: number[] = [];

    for (let i = 0; i < sortedDates.length; i++) {
        const date = sortedDates[i];
        const isToday = date === today;
        const cacheKey = timelyAccountCacheKey(accountId, `memories/memories-${date}.json`);
        const progress = `${i + 1}/${sortedDates.length}`;

        if (isToday || force) {
            fetchIndexes.push(i);
            continue;
        }

        const cached = await storage.getCacheFile<TimelyEntry[]>(cacheKey, CACHE_TTL);

        if (cached) {
            results[i] = cached;
            stats.cached++;
            logger.debug(`[memories] ${progress} ${date}: ${cached.length} memories (cached)`);
        } else {
            fetchIndexes.push(i);
        }
    }

    const fetchIndex = async (index: number, signal?: AbortSignal): Promise<void> => {
        const date = sortedDates[index];
        const isToday = date === today;
        const cacheKey = timelyAccountCacheKey(accountId, `memories/memories-${date}.json`);
        const progress = `${index + 1}/${sortedDates.length}`;

        try {
            const memories = await fetchFromApi({ accountId, accessToken, cookie, date, signal });
            results[index] = memories;

            if (!isToday) {
                await storage.putCacheFile(cacheKey, memories, CACHE_TTL);
            }

            stats.fetched++;
            logger.debug(
                `[memories] ${progress} ${date}: ${memories.length} memories (${isToday ? "fresh, today" : force ? "force refresh" : "fetched"})`
            );
        } catch (err) {
            if (signal?.aborted) {
                throw signal.reason ?? err;
            }

            if (isTimelyAuthFailure(err)) {
                logger.debug(`[memories] ${progress} ${date}: auth failure, aborting the run`);
                throw err;
            }

            stats.failed++;
            failedDates.push(date);
            logger.error(
                `[memories] ${progress} ${date}: FAILED - ${err instanceof Error ? err.message : String(err)}`
            );
        }
    };

    if (fetchIndexes.length > 0) {
        // Preserve the one-request credential failure contract before opening the pool.
        await fetchIndex(fetchIndexes[0]);
        const remaining = fetchIndexes.slice(1);
        const controller = new AbortController();
        let next = 0;
        let authFailure: unknown;

        const worker = async (): Promise<void> => {
            while (!controller.signal.aborted) {
                const job = next++;

                if (job >= remaining.length) {
                    return;
                }

                try {
                    await fetchIndex(remaining[job], controller.signal);
                } catch (err) {
                    if (isTimelyAuthFailure(err)) {
                        authFailure ??= err;
                        controller.abort(err);
                        return;
                    }

                    // Stop the sibling workers too: Promise.all rejects at once, and they would
                    // otherwise keep fetching and writing the cache after this call has failed.
                    controller.abort(err);
                    throw err;
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(MEMORIES_FETCH_CONCURRENCY, remaining.length) }, () => worker())
        );

        if (authFailure) {
            throw authFailure;
        }
    }

    for (let i = 0; i < sortedDates.length; i++) {
        const memories = results[i];

        if (memories) {
            entries.push(...memories);
            byDate.set(sortedDates[i], memories);
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
    signal?: AbortSignal;
}): Promise<TimelyEntry[]> {
    const { accountId, accessToken, cookie, date, signal } = options;
    const url = `https://app.timelyapp.com/${accountId}/suggested_entries.json?date=${date}&spam=true`;

    return (await fetchTimelyWebJson({
        url,
        accessToken,
        cookie,
        scope: "memories",
        label: `Memories request for ${date}`,
        signal,
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
