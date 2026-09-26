import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OriginDriver, PrInfo, PrLookup } from "@genesiscz/utils/git/origins";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage, withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

// `tools hub repo --pr` runs `driver.prForHead` (gh/glab) on every session click in the hub, and
// the host round trip is most of that click's cost. Cached keyed by origin URL + branch + head
// commit: a push or a branch switch changes the key, so it is a miss by construction, never a
// stale hit. A failed lookup (network error, rate limit, no host CLI) is never cached as "no PR" —
// only a clean answer, PR or genuinely none, is worth remembering.

const log = logger.child({ component: "hub/pr-lookup-cache" });

export const DEFAULT_PR_LOOKUP_CACHE_SECONDS = 60;
export const PR_LOOKUP_CACHE_CONFIG_KEY = "prLookupCacheSeconds";
const CACHE_FILE_NAME = "pr-lookup-cache.json";
/** One shared file, not one per key: bounded here so it can never grow without limit. */
const MAX_ENTRIES = 500;

interface PrLookupCacheEntry {
    pr: PrInfo | null;
    cachedAt: number;
}

interface PrLookupCacheFile {
    entries: Record<string, PrLookupCacheEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrInfo(value: unknown): value is PrInfo {
    return (
        isRecord(value) &&
        typeof value.number === "number" &&
        typeof value.state === "string" &&
        typeof value.target === "string" &&
        typeof value.url === "string"
    );
}

function isEntry(value: unknown): value is PrLookupCacheEntry {
    return isRecord(value) && typeof value.cachedAt === "number" && (value.pr === null || isPrInfo(value.pr));
}

function cachePath(storage: Storage): string {
    return join(storage.getCacheDir(), CACHE_FILE_NAME);
}

function readCacheFile(path: string): PrLookupCacheFile {
    if (!existsSync(path)) {
        return { entries: {} };
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"));
        const entries: Record<string, PrLookupCacheEntry> = {};

        if (isRecord(parsed) && isRecord(parsed.entries)) {
            for (const [key, value] of Object.entries(parsed.entries)) {
                if (isEntry(value)) {
                    entries[key] = value;
                }
            }
        }

        return { entries };
    } catch (err) {
        log.warn({ err, path }, "pr lookup cache unreadable; starting empty");
        return { entries: {} };
    }
}

/** Newest first, dropping anything older than `ttlMs`, then capped to `MAX_ENTRIES`. */
function prunedEntries(
    entries: Record<string, PrLookupCacheEntry>,
    ttlMs: number,
    now: number
): Record<string, PrLookupCacheEntry> {
    const alive = Object.entries(entries).filter(([, entry]) => now - entry.cachedAt <= ttlMs);
    alive.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
    return Object.fromEntries(alive.slice(0, MAX_ENTRIES));
}

export function prLookupCacheKey(originUrl: string, branch: string, head: string): string {
    return createHash("sha1").update(`${originUrl}\n${branch}\n${head}`).digest("hex");
}

/** The configured TTL in seconds; 0 turns the cache off. A missing or invalid value is the default. */
export async function readPrLookupCacheSeconds(storage = new Storage("hub")): Promise<number> {
    const value = await storage.getConfigValue<number>(PR_LOOKUP_CACHE_CONFIG_KEY);
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : DEFAULT_PR_LOOKUP_CACHE_SECONDS;
}

export async function writePrLookupCacheSeconds(seconds: number, storage = new Storage("hub")): Promise<number> {
    if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`the PR lookup cache TTL takes a whole number of seconds, 0 or more; got ${seconds}`);
    }

    const value = Math.floor(seconds);
    await storage.setConfigValue(PR_LOOKUP_CACHE_CONFIG_KEY, value);
    return value;
}

/**
 * `driver.prForHead`, through a persistent cache keyed by origin URL + branch + head commit (each
 * hub click is a new process, so the cache lives in a file, not memory). `fresh` skips the read
 * but still writes on success, so the next click benefits. TTL 0 (`ttlSeconds`, else the config
 * value) turns caching off entirely: never read, never written, `driver.prForHead` called every
 * time. A failed lookup is returned as-is and never cached.
 */
export async function cachedPrForHead({
    driver,
    originUrl,
    branch,
    head,
    fresh = false,
    ttlSeconds,
    storage = new Storage("hub"),
    now = () => Date.now(),
}: {
    driver: OriginDriver;
    originUrl: string;
    branch: string;
    head: string;
    fresh?: boolean;
    ttlSeconds?: number;
    storage?: Storage;
    now?: () => number;
}): Promise<PrLookup> {
    const ttl = ttlSeconds ?? (await readPrLookupCacheSeconds(storage));

    if (ttl <= 0) {
        return driver.prForHead(branch);
    }

    const ttlMs = ttl * 1000;
    const path = cachePath(storage);
    const key = prLookupCacheKey(originUrl, branch, head);

    if (!fresh) {
        const { entries } = readCacheFile(path);
        const hit = entries[key];

        if (hit && now() - hit.cachedAt <= ttlMs) {
            log.debug({ branch, head: head.slice(0, 8) }, "pr lookup cache hit");
            return { pr: hit.pr, error: null };
        }
    }

    const lookup = await driver.prForHead(branch);

    if (lookup.error !== null) {
        return lookup;
    }

    await withFileLock(`${path}.lock`, async () => {
        const current = readCacheFile(path);
        const at = now();
        current.entries[key] = { pr: lookup.pr, cachedAt: at };
        const next = prunedEntries(current.entries, ttlMs, at);
        atomicWriteFileSync(path, `${SafeJSON.stringify({ entries: next }, null, 2)}\n`);
    });

    return lookup;
}
