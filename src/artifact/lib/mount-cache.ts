import { logger } from "@genesiscz/utils/logger";

/**
 * Lazily-started, bounded cache of per-artifact sub-servers.
 *
 * Extracted from `startLibrary` so the state machine (absent → pending → ready
 * → evicted, plus failed-and-retryable) is testable without starting Vite.
 * Three rules it exists to keep:
 *   - concurrent requests to one mount share ONE start, never race two servers;
 *   - a failed start is not cached, so the next request retries it;
 *   - the map is bounded, because every live mount holds compiled modules,
 *     HMR state and file watchers.
 */
export interface MountCacheOptions<T> {
    /** Start a mount. Rejections are not cached. */
    start: (key: string) => Promise<T>;
    /** Close an evicted mount. */
    close: (value: T) => Promise<void>;
    /** Live mounts kept at once; the least recently used one is closed on overflow. */
    max?: number;
}

export const DEFAULT_MAX_MOUNTS = 8;

export interface MountCache<T> {
    get: (key: string) => Promise<T>;
    /** Keys currently held, least recently used first. */
    keys: () => string[];
    closeAll: () => Promise<void>;
}

export function createMountCache<T>({ start, close, max = DEFAULT_MAX_MOUNTS }: MountCacheOptions<T>): MountCache<T> {
    // Insertion order IS the recency order: a hit deletes and re-inserts.
    const mounts = new Map<string, Promise<T>>();

    const evictOldest = (): void => {
        while (mounts.size > max) {
            const oldest = mounts.keys().next();

            if (oldest.done) {
                return;
            }

            const pending = mounts.get(oldest.value);
            mounts.delete(oldest.value);
            logger.info({ key: oldest.value, max }, "[artifact] library: evicting the least recently used mount");
            void pending
                ?.then((value) => close(value))
                .catch((err: unknown) => {
                    logger.debug({ err, key: oldest.value }, "[artifact] library: evicted mount close failed");
                });
        }
    };

    return {
        get: (key: string): Promise<T> => {
            const existing = mounts.get(key);

            if (existing) {
                mounts.delete(key);
                mounts.set(key, existing);

                return existing;
            }

            const created = start(key);
            mounts.set(key, created);
            // A failed mount must not stay cached: the next request retries.
            created.catch((err: unknown) => {
                logger.warn({ err, key }, "[artifact] library mount failed");

                if (mounts.get(key) === created) {
                    mounts.delete(key);
                }
            });
            evictOldest();

            return created;
        },
        keys: () => [...mounts.keys()],
        closeAll: async (): Promise<void> => {
            const pending = [...mounts.values()];
            mounts.clear();

            // No mount's shutdown depends on another's, and this runs on the
            // process's way out, so one slow close must not queue up behind the
            // rest. Each keeps its own catch: a failure is logged, not fatal.
            await Promise.allSettled(
                pending.map(async (entry) => {
                    try {
                        await close(await entry);
                    } catch (err) {
                        logger.debug({ err }, "[artifact] library mount close failed");
                    }
                })
            );
        },
    };
}
