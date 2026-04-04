import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CacheEntry } from "@app/Internal/commands/reas/types";
import { SafeJSON } from "@app/utils/json";

const CACHE_DIR = join(homedir(), ".genesis-tools", "internal", "reas");

export const REAS_TTL = 24 * 60 * 60 * 1000;
export const SREALITY_TTL = 6 * 60 * 60 * 1000;
export const MF_TTL = 7 * 24 * 60 * 60 * 1000;

function ensureCacheDir(): void {
    if (!existsSync(CACHE_DIR)) {
        mkdirSync(CACHE_DIR, { recursive: true });
    }
}

export function cacheKey(params: Record<string, unknown>): string {
    const sorted = Object.keys(params)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
            acc[key] = params[key];
            return acc;
        }, {});

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(SafeJSON.stringify(sorted));
    return hasher.digest("hex");
}

export async function getCached<T>(key: string, ttlMs: number): Promise<CacheEntry<T> | null> {
    const filePath = join(CACHE_DIR, `${key}.json`);
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
        return null;
    }

    try {
        const entry: CacheEntry<T> = await file.json();
        const age = Date.now() - new Date(entry.fetchedAt).getTime();

        if (age > ttlMs) {
            return null;
        }

        return entry;
    } catch {
        return null;
    }
}

export async function setCache<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    ensureCacheDir();
    const filePath = join(CACHE_DIR, `${key}.json`);
    await Bun.write(filePath, SafeJSON.stringify(entry, null, 2));
}

export async function getCacheAge(key: string): Promise<number | null> {
    const filePath = join(CACHE_DIR, `${key}.json`);
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
        return null;
    }

    try {
        const entry: CacheEntry<unknown> = await file.json();
        return Date.now() - new Date(entry.fetchedAt).getTime();
    } catch {
        return null;
    }
}

export interface ProviderCacheStatus {
    provider: string;
    ttlMs: number;
    ageMs: number | null;
    isFresh: boolean;
}

export async function getProviderCacheStatuses(
    cacheKeys: Array<{ provider: string; key: string; ttlMs: number }>
): Promise<ProviderCacheStatus[]> {
    return Promise.all(
        cacheKeys.map(async ({ provider, key, ttlMs }) => {
            const ageMs = await getCacheAge(key);

            return {
                provider,
                ttlMs,
                ageMs,
                isFresh: ageMs !== null && ageMs <= ttlMs,
            };
        })
    );
}

export async function clearCache(): Promise<void> {
    if (!existsSync(CACHE_DIR)) {
        return;
    }

    const files = readdirSync(CACHE_DIR);

    for (const file of files) {
        if (file.endsWith(".json")) {
            unlinkSync(join(CACHE_DIR, file));
        }
    }
}
