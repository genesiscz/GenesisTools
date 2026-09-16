import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSessionRow, AgentSessionRowsOptions } from "@app/ai/lib/sessions/agent-session-rows";
import { aiDataDir } from "@genesiscz/utils/ai/config/paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * A resident answer for `tools ai usage sessions --json`.
 *
 * Genesis.app asks the same question every 35 seconds, and a fresh process walks
 * 3,796 directories and stats 12k files to answer it: 1.83 s of CPU, about 3.1 s
 * of CPU a minute for one unchanging list. The daemon already wakes once a minute
 * for `ai-usage-poll`, so it recomputes the list there and the CLI reads the file.
 *
 * The entry carries the QUERY, not just the rows: `--hours 1` must never be served
 * rows computed for `--hours 24`, and the daemon needs the query back to refresh
 * it. `lastRequestedAt` is what the daemon reads to decide whether anyone still
 * wants this query — an idle machine must not pay for a listing nobody asks for.
 */
export interface SessionRowsCache {
    /** The listing these rows answer. A different query is a miss. */
    query: AgentSessionRowsOptions;
    /** When the rows were computed. Emitted as `fetchedAt`, so age stays honest. */
    fetchedAt: number;
    /** When the CLI last served or wanted this query. */
    lastRequestedAt: number;
    rows: AgentSessionRow[];
}

/** 90 s: the daemon refreshes every 60 s, so a poller on any cadence hits a warm file. */
export const SESSION_ROWS_MAX_AGE_MS = 90_000;

/** The daemon stops refreshing a query nobody has asked for in an hour. */
export const SESSION_ROWS_KEEP_WARM_MS = 3_600_000;

export function sessionRowsCachePath(): string {
    return aiDataDir("usage-sessions.json");
}

/**
 * The query identity. Provider order must not change it, because
 * `--provider grok claude` and `--provider claude grok` are the same question.
 */
export function sessionRowsCacheKey(options: AgentSessionRowsOptions): string {
    return SafeJSON.stringify({
        providers: options.providers ? [...options.providers].sort() : null,
        hours: options.hours ?? null,
        minRows: options.minRows ?? null,
        limit: options.limit ?? null,
    });
}

export async function readSessionRowsCache(path = sessionRowsCachePath()): Promise<SessionRowsCache | null> {
    try {
        const file = Bun.file(path);

        if (!(await file.exists())) {
            return null;
        }

        const parsed = SafeJSON.parse(await file.text()) as SessionRowsCache;

        if (
            !parsed ||
            typeof parsed !== "object" ||
            !Array.isArray(parsed.rows) ||
            parsed.query === null ||
            typeof parsed.query !== "object"
        ) {
            return null;
        }

        return parsed;
    } catch (err) {
        // A truncated or hand-edited file is a cache miss, never a failed listing.
        logger.debug({ err, path }, "[ai] session rows cache unreadable");
        return null;
    }
}

export async function writeSessionRowsCache(entry: SessionRowsCache, path = sessionRowsCachePath()): Promise<void> {
    try {
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, SafeJSON.stringify(entry));
    } catch (err) {
        // The answer is already computed; failing to cache it must not fail the command.
        logger.debug({ err, path }, "[ai] session rows cache not written");
    }
}

/** True when `entry` answers `key` and is young enough to serve. */
export function cacheIsUsable(
    entry: SessionRowsCache | null,
    key: string,
    now: number,
    maxAgeMs = SESSION_ROWS_MAX_AGE_MS
): entry is SessionRowsCache {
    return entry !== null && sessionRowsCacheKey(entry.query) === key && now - entry.fetchedAt <= maxAgeMs;
}

/**
 * Recompute whatever query the CLI last asked for, so the next poll reads a warm
 * file. Called from the `ai-usage-poll` tick, which already wakes every minute.
 *
 * Does nothing when no query has ever been asked, and stops once an hour has
 * passed with nobody asking. Returns what it did, for the log line.
 */
export async function refreshSessionRowsCache(
    listRows: (options: AgentSessionRowsOptions) => Promise<AgentSessionRow[]>,
    { now = Date.now(), path = sessionRowsCachePath() }: { now?: number; path?: string } = {}
): Promise<{ refreshed: boolean; reason: string; rows?: number }> {
    const entry = await readSessionRowsCache(path);

    if (!entry) {
        return { refreshed: false, reason: "no query has been asked yet" };
    }

    if (now - entry.lastRequestedAt > SESSION_ROWS_KEEP_WARM_MS) {
        return { refreshed: false, reason: "nobody has asked for an hour" };
    }

    const rows = await listRows(entry.query);
    await writeSessionRowsCache({ ...entry, fetchedAt: now, rows }, path);

    return { refreshed: true, reason: "refreshed", rows: rows.length };
}
