import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import logger from "@app/logger";

/**
 * TTL string format: "<number> <unit>" or "<number><unit>"
 * Units: "second(s)", "minute(s)", "hour(s)", "day(s)", "week(s)"
 * Examples: "5 days", "1 hour", "30 minutes", "1 week"
 */
export type TTLString = string;

export class Storage {
    private toolName: string;
    private baseDir: string;
    private cacheDir: string;
    private configPath: string;

    /**
     * Create a Storage instance for a tool
     * @param toolName - Name of the tool (e.g., "timely", "ask")
     */
    constructor(toolName: string) {
        this.toolName = toolName;
        this.baseDir = join(homedir(), ".genesis-tools", toolName);
        this.cacheDir = join(this.baseDir, "cache");
        this.configPath = join(this.baseDir, "config.json");
    }

    // ============================================
    // Directory Management
    // ============================================

    /**
     * Get the base directory for this tool
     * @returns Absolute path to ~/.genesis-tools/<toolName>
     */
    getBaseDir(): string {
        return this.baseDir;
    }

    /**
     * Get the cache directory for this tool
     * @returns Absolute path to ~/.genesis-tools/<toolName>/cache
     */
    getCacheDir(): string {
        return this.cacheDir;
    }

    /**
     * Get the config file path
     * @returns Absolute path to ~/.genesis-tools/<toolName>/config.json
     */
    getConfigPath(): string {
        return this.configPath;
    }

    /**
     * Ensure all required directories exist
     * Creates: baseDir, cacheDir
     */
    async ensureDirs(): Promise<void> {
        if (!existsSync(this.baseDir)) {
            mkdirSync(this.baseDir, { recursive: true });
            logger.debug(`Created directory: ${this.baseDir}`);
        }

        if (!existsSync(this.cacheDir)) {
            mkdirSync(this.cacheDir, { recursive: true });
            logger.debug(`Created directory: ${this.cacheDir}`);
        }
    }

    // ============================================
    // Config Management
    // ============================================

    /**
     * Read the entire config object
     * @returns The config object or null if not found
     */
    async getConfig<T extends object>(): Promise<T | null> {
        try {
            if (!existsSync(this.configPath)) {
                return null;
            }
            const content = await Bun.file(this.configPath).text();
            return JSON.parse(content) as T;
        } catch (error) {
            logger.error(`Failed to read config: ${error}`);
            return null;
        }
    }

    /**
     * Get a specific value from config
     * @param key - The config key (supports dot notation: "oauth2.access_token")
     * @returns The value or undefined
     */
    async getConfigValue<T>(key: string): Promise<T | undefined> {
        const config = await this.getConfig<Record<string, unknown>>();
        if (!config) return undefined;

        // Support dot notation
        const keys = key.split(".");
        let value: unknown = config;
        for (const k of keys) {
            if (value && typeof value === "object" && k in value) {
                value = (value as Record<string, unknown>)[k];
            } else {
                return undefined;
            }
        }
        return value as T;
    }

    /**
     * Set a value in config (merges with existing config)
     * @param key - The config key (supports dot notation)
     * @param value - The value to set
     */
    async setConfigValue<T>(key: string, value: T): Promise<void> {
        await this.ensureDirs();
        const config = (await this.getConfig<Record<string, unknown>>()) || {};

        // Support dot notation for nested keys
        const keys = key.split(".");
        let current = config;
        for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (!(k in current) || typeof current[k] !== "object") {
                current[k] = {};
            }
            current = current[k] as Record<string, unknown>;
        }
        current[keys[keys.length - 1]] = value;

        await Bun.write(this.configPath, JSON.stringify(config, null, 2));
        logger.debug(`Config updated: ${key}`);
    }

    /**
     * Set the entire config object
     * @param config - The config object to save
     */
    async setConfig<T extends object>(config: T): Promise<void> {
        await this.ensureDirs();
        await Bun.write(this.configPath, JSON.stringify(config, null, 2));
        logger.debug(`Config saved`);
    }

    /**
     * Clear the config (delete config.json)
     */
    async clearConfig(): Promise<void> {
        try {
            if (existsSync(this.configPath)) {
                unlinkSync(this.configPath);
                logger.debug(`Config cleared`);
            }
        } catch (error) {
            logger.error(`Failed to clear config: ${error}`);
        }
    }

    // ============================================
    // Cache Management
    // ============================================

    /**
     * Parse TTL string to milliseconds
     * @param ttl - TTL string like "5 days", "1 hour", "30 minutes"
     * @returns Milliseconds
     */
    parseTTL(ttl: TTLString): number {
        const match = ttl.trim().match(/^(\d+)\s*(second|minute|hour|day|week)s?$/i);
        if (!match) {
            throw new Error(`Invalid TTL format: "${ttl}". Use format like "5 days", "1 hour", "30 minutes"`);
        }

        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();

        const multipliers: Record<string, number> = {
            second: 1000,
            minute: 60 * 1000,
            hour: 60 * 60 * 1000,
            day: 24 * 60 * 60 * 1000,
            week: 7 * 24 * 60 * 60 * 1000,
        };

        return value * multipliers[unit];
    }

    /**
     * Get the full path for a cache file
     * @param relativePath - Relative path within cache directory
     * @returns Absolute path
     */
    private getCacheFilePath(relativePath: string): string {
        return join(this.cacheDir, relativePath);
    }

    /**
     * Check if a cache file is expired based on file modification time
     * @param filePath - Absolute path to the cache file
     * @param ttlMs - TTL in milliseconds
     * @returns true if expired or doesn't exist
     */
    private isCacheFileExpired(filePath: string, ttlMs: number): boolean {
        try {
            if (!existsSync(filePath)) {
                return true;
            }

            const stats = statSync(filePath);
            const age = Date.now() - stats.mtimeMs;
            return age > ttlMs;
        } catch {
            return true;
        }
    }

    /**
     * Put a file in the cache (saves as raw JSON, no metadata wrapper)
     * Expiration is checked via file modification time
     * @param relativePath - Relative path within cache directory
     * @param data - Data to cache (will be JSON stringified)
     * @param ttl - TTL string (expiration checked via file mtime)
     */
    async putCacheFile<T>(relativePath: string, data: T, ttl: TTLString): Promise<void> {
        await this.ensureDirs();
        const filePath = this.getCacheFilePath(relativePath);

        // Ensure parent directory exists
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        // Save raw JSON without metadata wrapper
        const content = JSON.stringify(data, null, 2);
        await Bun.write(filePath, content);
        logger.debug(`Cache written: ${filePath}`);
    }

    /**
     * Get a file from cache (returns null if not found or expired)
     * Expiration is checked based on file modification time
     * @param relativePath - Relative path within cache directory
     * @param ttl - TTL string to check expiration
     * @returns Cached data or null
     */
    async getCacheFile<T>(relativePath: string, ttl: TTLString): Promise<T | null> {
        const filePath = this.getCacheFilePath(relativePath);
        const ttlMs = this.parseTTL(ttl);

        if (this.isCacheFileExpired(filePath, ttlMs)) {
            return null;
        }

        try {
            const content = await Bun.file(filePath).text();
            return JSON.parse(content) as T;
        } catch {
            return null;
        }
    }

    /**
     * Get cached file or fetch and cache it
     * @param relativePath - Relative path within cache directory
     * @param fetcher - Async function to fetch data if not cached
     * @param ttl - TTL string like "5 days"
     * @returns Cached or fetched data
     */
    async getFileOrPut<T>(relativePath: string, fetcher: () => Promise<T>, ttl: TTLString): Promise<T> {
        const filePath = this.getCacheFilePath(relativePath);

        // Try to get from cache first
        const cached = await this.getCacheFile<T>(relativePath, ttl);
        if (cached !== null) {
            logger.debug(`Cache hit: ${filePath}`);
            return cached;
        }

        // Fetch fresh data
        logger.debug(`Cache miss: ${filePath}, fetching...`);
        const data = await fetcher();

        // Store in cache
        await this.putCacheFile(relativePath, data, ttl);

        return data;
    }

    /**
     * Delete a specific cache file
     * @param relativePath - Relative path within cache directory
     */
    async deleteCacheFile(relativePath: string): Promise<void> {
        const filePath = this.getCacheFilePath(relativePath);
        try {
            if (existsSync(filePath)) {
                unlinkSync(filePath);
                logger.debug(`Cache deleted: ${relativePath}`);
            }
        } catch (error) {
            logger.error(`Failed to delete cache file: ${error}`);
        }
    }

    /**
     * Clear all cache files
     */
    async clearCache(): Promise<void> {
        try {
            const removeDir = (dir: string) => {
                if (!existsSync(dir)) return;
                const files = readdirSync(dir, { withFileTypes: true });
                for (const file of files) {
                    const filePath = join(dir, file.name);
                    if (file.isDirectory()) {
                        removeDir(filePath);
                    } else {
                        unlinkSync(filePath);
                    }
                }
            };
            removeDir(this.cacheDir);
            // Recreate empty cache directory
            mkdirSync(this.cacheDir, { recursive: true });
            logger.debug(`Cache cleared for ${this.toolName}`);
        } catch (error) {
            logger.error(`Failed to clear cache: ${error}`);
        }
    }

    /**
     * List all cache files
     * @param absolute - If true, returns absolute paths; if false, returns relative paths (default: true)
     * @returns Array of paths (absolute or relative based on parameter)
     */
    async listCacheFiles(absolute: boolean = true): Promise<string[]> {
        const files: string[] = [];

        const walkDir = (dir: string, prefix: string = "") => {
            if (!existsSync(dir)) return;
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    walkDir(join(dir, entry.name), relativePath);
                } else if (entry.name.endsWith(".json") || entry.name.endsWith(".md")) {
                    // Return absolute or relative path based on parameter
                    const path = absolute ? join(this.cacheDir, relativePath) : relativePath;
                    files.push(path);
                }
            }
        };

        walkDir(this.cacheDir);
        return files;
    }

    /**
     * Get cache statistics
     * @returns Object with count and total size
     */
    async getCacheStats(): Promise<{ count: number; totalSizeBytes: number }> {
        let count = 0;
        let totalSizeBytes = 0;

        const walkDir = (dir: string) => {
            if (!existsSync(dir)) return;
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const filePath = join(dir, entry.name);
                if (entry.isDirectory()) {
                    walkDir(filePath);
                } else {
                    count++;
                    const stats = statSync(filePath);
                    totalSizeBytes += stats.size;
                }
            }
        };

        walkDir(this.cacheDir);
        return { count, totalSizeBytes };
    }

    // ============================================
    // Raw File Management (for non-JSON content)
    // ============================================

    /**
     * Put a raw file in the cache (for non-JSON content like markdown, text, etc.)
     * Expiration is checked via file modification time
     * @param relativePath - Relative path within cache directory
     * @param content - Raw file content (string)
     * @param ttl - TTL string (expiration checked via file mtime)
     */
    async putRawFile(relativePath: string, content: string, ttl: TTLString): Promise<void> {
        await this.ensureDirs();
        const filePath = this.getCacheFilePath(relativePath);

        // Ensure parent directory exists
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        await Bun.write(filePath, content);
        logger.debug(`Raw file written: ${filePath}`);
    }

    /**
     * Get a raw file from cache (returns null if not found or expired)
     * Expiration is checked based on file modification time
     * @param relativePath - Relative path within cache directory
     * @param ttl - TTL string to check expiration
     * @returns Raw file content or null
     */
    async getRawFile(relativePath: string, ttl: TTLString): Promise<string | null> {
        const filePath = this.getCacheFilePath(relativePath);
        const ttlMs = this.parseTTL(ttl);

        if (this.isCacheFileExpired(filePath, ttlMs)) {
            return null;
        }

        try {
            const content = await Bun.file(filePath).text();
            return content;
        } catch {
            return null;
        }
    }
}
