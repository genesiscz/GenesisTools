import { join } from "node:path";
import { Storage } from "@genesiscz/utils/storage/storage";

const TOOL_NAME = "ai-usage";

/**
 * `~/.genesis-tools/ai-usage/` — the provider-neutral home of the poll core
 * (spec 2026-09-04 section 6.3). Every key here carries the plugin id, so two
 * providers never share a cache entry, a file lock or a notification tracker.
 *
 * The claude-only `~/.genesis-tools/claude-usage/` store still exists: it holds
 * the legacy `usage-shared` file the Genesis app reads (`legacy-cache.ts`).
 */
export class AiUsageStorage extends Storage {
    constructor() {
        super(TOOL_NAME);
    }
}

let _instance: AiUsageStorage | null = null;

export function usagePollStorage(): AiUsageStorage {
    if (!_instance) {
        _instance = new AiUsageStorage();
    }

    return _instance;
}

/** Drop the memoised store. `Storage` captures its root at construction; tests move it. */
export function __resetUsagePollStorage(): void {
    _instance = null;
}

/** Long TTL: freshness is decided by our own `fetchedAt` stamps, never by mtime. */
export const USAGE_CACHE_TTL = "365 days" as const;

export function snapshotsCacheKey(provider: string): string {
    return `snapshots:${provider}`;
}

export function pollGateCacheKey(provider: string): string {
    return `poll-gate:${provider}`;
}

export function notifyCacheKey(provider: string): string {
    return `notify:${provider}`;
}

/** Absolute path of a cache key, for the file lock. */
export function usageCacheFilePath(key: string): string {
    return join(usagePollStorage().getCacheDir(), key);
}
