import { stat } from "node:fs/promises";
import type { AiUsageResult } from "@app/dev-dashboard/contract/ai-accounts";
import { flattenSnapshotsCache } from "@app/dev-dashboard/lib/ai-accounts/snapshots";
import type { LiveHub } from "@app/dev-dashboard/lib/live/hub";
import { readSnapshotsCache, snapshotsCachePath } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { logger } from "@genesiscz/utils/logger";

export const AI_USAGE_INTERVAL_MS = 5_000;

/**
 * A poll of the usage cache file, NOT `fs.watch`. The writer is
 * `Storage.withFileLock` + an atomic rename, which replaces the inode; macOS
 * routinely drops the watch on that and the dashboard would then sit on a stale
 * snapshot until the next reload. A 5s stat is two syscalls and cannot miss.
 *
 * Only the daemon's out-of-process polls need this. An in-process refresh
 * publishes through `publishAiUsage` the moment it finishes.
 */
export interface AiUsageProducerDeps {
    intervalMs?: number;
    cachePath?: () => string;
    /** `null` means the file was there but held nothing usable; nothing is published. */
    readCache?: () => Promise<AiUsageResult | null>;
}

export interface AiUsageProducer {
    start(): void;
    stop(): void;
    /** One read-and-publish pass, ignoring the mtime stamp. Exposed for tests. */
    tick(): Promise<void>;
}

/** Publish a usage payload to every `ai-usage` subscriber. */
export function publishAiUsage(hub: LiveHub, payload: AiUsageResult): void {
    hub.publish({ v: 1, channel: "ai-usage", type: "snapshot", payload });
}

async function defaultReadCache(): Promise<AiUsageResult | null> {
    const cache = await readSnapshotsCache();
    return cache ? flattenSnapshotsCache(cache) : null;
}

export function createAiUsageProducer(hub: LiveHub, deps: AiUsageProducerDeps = {}): AiUsageProducer {
    const intervalMs = deps.intervalMs ?? AI_USAGE_INTERVAL_MS;
    const pathOf = deps.cachePath ?? snapshotsCachePath;
    const readCache = deps.readCache ?? defaultReadCache;
    let timer: ReturnType<typeof setInterval> | null = null;
    let busy = false;
    let stamp: string | null = null;

    async function tick(): Promise<void> {
        if (busy || hub.subscriberCount("ai-usage") === 0) {
            return;
        }

        busy = true;
        const path = pathOf();

        try {
            const info = await stat(path);
            const next = `${info.mtimeMs}:${info.size}`;

            if (next === stamp) {
                return;
            }

            stamp = next;
            const payload = await readCache();

            if (!payload) {
                logger.debug({ path }, "live/ai-usage: snapshots cache held nothing usable");
                return;
            }

            publishAiUsage(hub, payload);
        } catch (err) {
            // A missing file is the normal state before the first poll ever runs.
            // Forget the stamp so the file's arrival is seen as a change.
            stamp = null;
            logger.debug({ err, path }, "live/ai-usage: snapshots cache unreadable");
        } finally {
            busy = false;
        }
    }

    return {
        start() {
            if (timer) {
                return;
            }

            void tick();
            timer = setInterval(() => void tick(), intervalMs);
        },

        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }

            stamp = null;
        },

        tick,
    };
}
