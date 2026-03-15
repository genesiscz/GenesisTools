import { mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CacheEntry } from "../types";

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
    hasher.update(JSON.stringify(sorted));
    return hasher.digest("hex");
}

export async function getCached<T>(key: string, ttlMs: number): Promise<CacheEntry<T> | null> {
    const filePath = join(CACHE_DIR, `${key}.json`);
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
        return null;
    }

    const entry: CacheEntry<T> = await file.json();
    const age = Date.now() - new Date(entry.fetchedAt).getTime();

    if (age > ttlMs) {
        return null;
    }

    return entry;
}

export async function setCache<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    ensureCacheDir();
    const filePath = join(CACHE_DIR, `${key}.json`);
    await Bun.write(filePath, JSON.stringify(entry, null, 2));
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
