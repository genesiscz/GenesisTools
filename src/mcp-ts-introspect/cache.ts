import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import logger from "../logger";
import type { CacheEntry, ExportInfo } from "./types";

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function loadCache(cacheDir: string, key: string): Promise<ExportInfo[] | null> {
    const cacheFile = join(cacheDir, `${key}.json`);

    if (!existsSync(cacheFile)) {
        return null;
    }

    try {
        const cacheData = (await Bun.file(cacheFile).json()) as CacheEntry;

        // Check if cache is still valid
        const age = Date.now() - cacheData.timestamp;
        if (age > CACHE_TTL) {
            logger.info(`Cache for ${key} is expired (${Math.floor(age / 1000 / 60 / 60)} hours old)`);
            return null;
        }

        logger.info(`Loaded cache for ${key} (${Math.floor(age / 1000 / 60)} minutes old)`);
        return cacheData.exports;
    } catch (error) {
        logger.warn(`Failed to load cache for ${key}: ${error}`);
        return null;
    }
}

export async function saveCache(cacheDir: string, key: string, exports: ExportInfo[]): Promise<void> {
    try {
        // Ensure cache directory exists
        if (!existsSync(cacheDir)) {
            await mkdir(cacheDir, { recursive: true });
        }

        const cacheFile = join(cacheDir, `${key}.json`);
        const cacheEntry: CacheEntry = {
            exports,
            timestamp: Date.now(),
        };

        await Bun.write(cacheFile, JSON.stringify(cacheEntry, null, 2));
        logger.info(`Saved cache for ${key} (${exports.length} exports)`);
    } catch (error) {
        logger.warn(`Failed to save cache for ${key}: ${error}`);
        // Don't throw - caching is optional
    }
}
