import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { historyDatabasePath } from "./database";

/**
 * When a provider's listing last refreshed the index, across processes.
 *
 * A listing's refresh (walk, then re-read of changed sources) keeps every changed source current
 * whatever its window, because a changed file's mtime is always inside the window. So a caller
 * that tolerates a few seconds of lag can read the index as it is when another process refreshed
 * the same scope moments ago. The inbox, the hub timeline and the hub worktrees poll every 20 to
 * 30 s beside the Genesis session list, and each paid its own walk of all three providers.
 */
export interface ListingFreshness {
    /** Milliseconds since the scope was last refreshed, or null when never (or unreadable). */
    age(key: string): number | null;
    /** Records a finished refresh of the scope. */
    touch(key: string): void;
}

/**
 * One empty marker file per scope; its mtime is the refresh time. No lock and no JSON: a marker
 * write is a single `writeFileSync`, and the last writer wins, which is the right answer here.
 */
export function fileListingFreshness(
    directory = join(dirname(historyDatabasePath()), "listing-fresh")
): ListingFreshness {
    const markerPath = (key: string) => join(directory, `${Bun.hash(key).toString(16)}.stamp`);

    return {
        age(key) {
            try {
                return Date.now() - statSync(markerPath(key)).mtimeMs;
            } catch (error) {
                logger.debug({ error, key }, "[history] no listing freshness marker; the listing refreshes");
                return null;
            }
        },
        touch(key) {
            try {
                mkdirSync(directory, { recursive: true });
                writeFileSync(markerPath(key), "");
            } catch (error) {
                logger.debug({ error, key }, "[history] listing freshness marker not written");
            }
        },
    };
}
