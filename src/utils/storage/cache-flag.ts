import { logger } from "@genesiscz/utils/logger";
import { InvalidArgumentError, Option } from "commander";
import type { Storage } from "./storage";

/**
 * The CLI answers fresh by default; a cached answer only when the caller passes `--max-cache-age
 * <seconds>`. `cached` is that rule over `Storage.getCacheFile` / `putCacheFile`, and
 * `maxCacheAgeOption` is the one flag every command declares for it.
 */

type CacheStorage = Pick<Storage, "getCacheFile" | "putCacheFile">;

/**
 * `fetch()`, or a stored answer at most `maxAgeSeconds` old. Undefined or 0 always fetches, and still
 * writes the fresh result, so a later call with a max age can use it. `isValid` adds a check beyond
 * age (a head sha, a file fingerprint); `shouldStore` keeps an answer out of the cache (unfinished).
 * A failed cache write (full disk, unwritable dir) is logged, never thrown: the fetched value stands.
 */
export async function cached<T>({
    storage,
    key,
    maxAgeSeconds,
    fetch,
    isValid,
    shouldStore,
}: {
    storage: CacheStorage;
    key: string;
    maxAgeSeconds?: number;
    fetch: () => Promise<T>;
    isValid?: (hit: T) => boolean;
    shouldStore?: (value: T) => boolean;
}): Promise<{ value: T; hit: boolean }> {
    if (maxAgeSeconds !== undefined && maxAgeSeconds > 0) {
        const hit = await storage.getCacheFile<T>(key, `${Math.ceil(maxAgeSeconds)} seconds`);

        if (hit !== null && (!isValid || isValid(hit))) {
            return { value: hit, hit: true };
        }
    }

    const value = await fetch();

    if (!shouldStore || shouldStore(value)) {
        try {
            await storage.putCacheFile(key, value, `${Math.max(1, Math.ceil(maxAgeSeconds ?? 0))} seconds`);
        } catch (error) {
            logger.warn({ error, key }, "cache write failed; the fetched answer is returned uncached");
        }
    }

    return { value, hit: false };
}

/**
 * A cache whose own rule is stricter than the caller's (a live page moves every minute): the caller's
 * max age, but never past `ownSeconds`. Undefined keeps the cache's own rule, 0 stays 0.
 */
export function capMaxCacheAge(requested: number | undefined, ownSeconds: number): number {
    return requested === undefined ? ownSeconds : Math.min(requested, ownSeconds);
}

/** Commander parser for `--max-cache-age`: a whole number of seconds, 0 or more. */
export function parseMaxCacheAge(raw: string): number {
    const value = Number(raw);

    if (raw.trim() === "" || !Number.isInteger(value) || value < 0) {
        throw new InvalidArgumentError(`takes a whole number of seconds, 0 or more; got "${raw}".`);
    }

    return value;
}

/** `--max-cache-age <seconds>`; add it with `command.addOption(maxCacheAgeOption())`. */
export function maxCacheAgeOption(what = "answer"): Option {
    return new Option(
        "--max-cache-age <seconds>",
        `serve a cached ${what} at most this many seconds old (default: always fetch fresh)`
    ).argParser(parseMaxCacheAge);
}

/**
 * The age a command asks for: `--fresh` / `--no-cache` (kept so old callers still parse) mean 0,
 * else `--max-cache-age`, else 0, since the CLI answers fresh by default.
 */
export function resolveMaxCacheAge({ maxCacheAge, fresh }: { maxCacheAge?: number; fresh?: boolean }): number {
    return fresh ? 0 : (maxCacheAge ?? 0);
}
