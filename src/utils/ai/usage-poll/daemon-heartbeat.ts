import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { API_MIN_INTERVAL_MS } from "./shared-cache";
import { usageCacheFilePath } from "./storage";

/** The `ai-usage-poll` daemon task's tick (`tools daemon config`). */
export const DAEMON_TICK_MS = 60_000;

/** Room for the daemon's own fetch after a tick: the median round took 9.4 s. */
const DAEMON_FETCH_SLACK_MS = 30_000;

/** A heartbeat younger than this means the daemon is ticking and will refresh the cache itself. */
export const DAEMON_ALIVE_MS = 2 * DAEMON_TICK_MS + DAEMON_FETCH_SLACK_MS;

function heartbeatPath(): string {
    return usageCacheFilePath("daemon.heartbeat");
}

/** The daemon marks each successful round. Only the daemon calls this. */
export function touchUsageDaemonHeartbeat(): void {
    const path = heartbeatPath();

    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "");
    } catch (error) {
        logger.debug({ error, path }, "[usage] daemon heartbeat not written; readers fetch on their own clock");
    }
}

/** Milliseconds since the daemon's last successful round, or null when it never marked one. */
export function usageDaemonAgeMs(): number | null {
    try {
        return Date.now() - statSync(heartbeatPath()).mtimeMs;
    } catch (error) {
        logger.debug({ error }, "[usage] no daemon heartbeat; readers fetch on their own clock");
        return null;
    }
}

/**
 * How old a cached row a reader (anything but the daemon's `force` round) may be served.
 *
 * On its own a reader refetches once a row passes the provider's floor. But the daemon refetches
 * at the same floor on a 60 s tick, and it stamps a row when the fetch ENDS, so the next tick sees
 * a 51 s row, skips, and the one after fetches: rows live about two ticks. Genesis polls every
 * 30 s, so it met a row past the floor first and fetched itself: 1,161 of its 2,528 polls on
 * 2026-09-25 went to the API (73 of 1,358 daemon rounds did), each costing a 0.5 to 10 s wait,
 * and every extra round is another chance at the 429 that forces a token refresh. While the
 * daemon's heartbeat is fresh, a reader trusts a row for the daemon's own cycle: floor, one tick
 * and the fetch. A dead daemon leaves readers on the floor, as before.
 */
export function readerMaxStaleMs(options: { floorMs: number; daemonAgeMs: number | null }): number {
    const own = Math.max(API_MIN_INTERVAL_MS, options.floorMs);

    if (options.daemonAgeMs === null || options.daemonAgeMs >= DAEMON_ALIVE_MS) {
        return own;
    }

    return Math.max(own, options.floorMs + DAEMON_TICK_MS + DAEMON_FETCH_SLACK_MS);
}
