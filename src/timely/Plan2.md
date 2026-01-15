# Timely CLI Tool - Enhanced Implementation Plan (Plan2)

## Overview

This plan details the implementation of:

1. **Reusable Storage Utility** (`src/utils/storage/storage.ts`) - A generic storage class for any GenesisTools CLI
2. **Timely CLI Tool** (`src/timely/`) - A CLI for interacting with the Timely time tracking API

This plan follows patterns from:

-   `src/ask/` - Complex CLI with multiple commands, providers, and managers
-   `src/git-commit/` - Simple CLI with Enquirer prompts and Bun.spawn
-   `src/ask/output/UsageDatabase.ts` - Uses `~/.genesis-tools/` directory pattern

---

## Part 1: Storage Utility (`src/utils/storage/storage.ts`)

### Directory Structure

```
src/
├── utils/
│   └── storage/
│       ├── storage.ts          # Main Storage class
│       └── index.ts            # Re-export for cleaner imports
└── utils.ts                    # Existing utility file (unchanged)
```

### Storage Location Pattern

Following the existing pattern from `UsageDatabase.ts`:

```
~/.genesis-tools/
├── ask/                        # Existing: ask tool data
│   └── ask.sqlite
├── timely/                     # New: timely tool data
│   ├── config.json            # Persistent configuration
│   └── cache/                 # Cached API responses
│       └── events/
│           └── 2025-11-01.json
└── <other-tools>/
```

### TypeScript Interface: `Storage`

```typescript
// src/utils/storage/storage.ts

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

export interface CacheMetadata {
    createdAt: number; // Unix timestamp in milliseconds
    ttlMs: number; // TTL in milliseconds (for reference)
}

export interface CacheFileContent<T> {
    metadata: CacheMetadata;
    data: T;
}

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
     * Check if a cache file is expired
     * @param filePath - Absolute path to the cache file
     * @param ttlMs - TTL in milliseconds
     * @returns true if expired or doesn't exist
     */
    private async isExpired(filePath: string, ttlMs: number): Promise<boolean> {
        try {
            if (!existsSync(filePath)) {
                return true;
            }

            const content = await Bun.file(filePath).text();
            const parsed = JSON.parse(content) as CacheFileContent<unknown>;

            if (!parsed.metadata?.createdAt) {
                return true;
            }

            const age = Date.now() - parsed.metadata.createdAt;
            return age > ttlMs;
        } catch {
            return true;
        }
    }

    /**
     * Put a file in the cache
     * @param relativePath - Relative path within cache directory
     * @param data - Data to cache
     * @param ttl - TTL string (stored in metadata for reference)
     */
    async putCacheFile<T>(relativePath: string, data: T, ttl: TTLString): Promise<void> {
        await this.ensureDirs();
        const filePath = this.getCacheFilePath(relativePath);

        // Ensure parent directory exists
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const content: CacheFileContent<T> = {
            metadata: {
                createdAt: Date.now(),
                ttlMs: this.parseTTL(ttl),
            },
            data,
        };

        await Bun.write(filePath, JSON.stringify(content, null, 2));
        logger.debug(`Cache written: ${relativePath}`);
    }

    /**
     * Get a file from cache (returns null if not found or expired)
     * @param relativePath - Relative path within cache directory
     * @param ttl - TTL string to check expiration
     * @returns Cached data or null
     */
    async getCacheFile<T>(relativePath: string, ttl: TTLString): Promise<T | null> {
        const filePath = this.getCacheFilePath(relativePath);
        const ttlMs = this.parseTTL(ttl);

        if (await this.isExpired(filePath, ttlMs)) {
            return null;
        }

        try {
            const content = await Bun.file(filePath).text();
            const parsed = JSON.parse(content) as CacheFileContent<T>;
            return parsed.data;
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
        // Try to get from cache first
        const cached = await this.getCacheFile<T>(relativePath, ttl);
        if (cached !== null) {
            logger.debug(`Cache hit: ${relativePath}`);
            return cached;
        }

        // Fetch fresh data
        logger.debug(`Cache miss: ${relativePath}, fetching...`);
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
     * @returns Array of relative paths
     */
    async listCacheFiles(): Promise<string[]> {
        const files: string[] = [];

        const walkDir = (dir: string, prefix: string = "") => {
            if (!existsSync(dir)) return;
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    walkDir(join(dir, entry.name), relativePath);
                } else if (entry.name.endsWith(".json")) {
                    files.push(relativePath);
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
}
```

### Re-export Index

```typescript
// src/utils/storage/index.ts

export { Storage, type TTLString, type CacheMetadata, type CacheFileContent } from "./storage";
```

---

## Part 2: Timely Tool Directory Structure

```
src/timely/
├── Plan.md                     # Original plan (keep for reference)
├── Plan2.md                    # This enhanced plan
├── index.ts                    # Main CLI entry point
│
├── types/
│   ├── index.ts               # Re-export all types
│   ├── config.ts              # Configuration types (OAuth, app settings)
│   ├── api.ts                 # API response types (accounts, projects, events)
│   └── cli.ts                 # CLI argument types
│
├── api/
│   ├── index.ts               # Re-export API client and service
│   ├── client.ts              # TimelyApiClient class (HTTP + OAuth)
│   └── service.ts             # TimelyService class (all API endpoints)
│
├── commands/
│   ├── index.ts               # Command registry
│   ├── login.ts               # OAuth2 login flow
│   ├── logout.ts              # Clear tokens
│   ├── status.ts              # Show current config status
│   ├── accounts.ts            # List/select accounts
│   ├── projects.ts            # List/select projects
│   ├── events.ts              # List events
│   ├── export-month.ts        # Export month's time entries
│   └── cache.ts               # Cache management
│
└── utils/
    ├── auth.ts                # OAuth2 helpers (browser open, code exchange)
    ├── date.ts                # Date range utilities
    └── display.ts             # Table/formatting utilities
```

---

## Part 3: TypeScript Types

### Configuration Types (`types/config.ts`)

```typescript
// src/timely/types/config.ts

/**
 * OAuth2 tokens stored in config
 */
export interface OAuth2Tokens {
    access_token: string;
    token_type: string; // Usually "bearer"
    refresh_token: string;
    created_at: number; // Unix timestamp (seconds)
    expires_in?: number; // Seconds until expiration (usually 7200)
    scope?: string; // OAuth scope
}

/**
 * OAuth2 application credentials (from Timely developer settings)
 */
export interface OAuthApplication {
    client_id: string;
    client_secret: string;
    redirect_uri: string; // Usually "urn:ietf:wg:oauth:2.0:oob" for CLI
}

/**
 * Main config stored in ~/.genesis-tools/timely/config.json
 */
export interface TimelyConfig {
    oauth?: OAuthApplication; // OAuth app credentials
    tokens?: OAuth2Tokens; // Current access/refresh tokens
    selectedAccountId?: number; // Default account ID
    selectedProjectId?: number; // Default project ID (optional)
    user?: {
        id: number;
        email: string;
        name: string;
    };
}
```

### API Types (`types/api.ts`)

```typescript
// src/timely/types/api.ts

// ============================================
// Common Types
// ============================================

export interface Currency {
    id: string;
    name: string;
    iso_code: string;
    symbol: string;
    symbol_first: boolean;
}

export interface Duration {
    hours: number;
    minutes: number;
    seconds: number;
    formatted: string;
    total_hours: number;
    total_seconds: number;
    total_minutes: number;
}

export interface Cost {
    fractional: number;
    formatted: string;
    amount: number;
    currency_code: string;
}

export interface Avatar {
    large_retina: string;
    large: string;
    medium_retina: string;
    medium: string;
    timeline: string;
}

export interface Logo {
    large_retina: string;
    medium_retina: string;
    small_retina: string;
    brand_logo: boolean;
}

// ============================================
// Account
// ============================================

export interface TimelyAccount {
    id: number;
    name: string;
    color: string;
    currency: Currency;
    logo: Logo;
    from: string;
    max_users: number;
    seats: number;
    max_projects: number;
    plan_id: number;
    plan_name: string;
    plan_code: string;
    next_charge: string;
    start_of_week: number;
    created_at: number;
    payment_mode: string;
    paid: boolean;
    company_size: string;
    owner_id: number;
    weekly_user_capacity: number;
    default_work_days: string;
    default_hour_rate: number;
    support_email: string;
    memory_retention_days: number;
    num_users: number;
    num_projects: number;
    active_projects_count: number;
    total_projects_count: number;
    capacity: Duration;
    status: string;
    beta: boolean;
    expired: boolean;
    trial: boolean;
    days_to_end_trial: number;
    features: Array<{ name: string; days: number }>;
}

// ============================================
// Client
// ============================================

export interface TimelyClient {
    id: number;
    name: string;
    color: string;
    active: boolean;
    external_id: string | null;
    updated_at: string;
}

// ============================================
// Label
// ============================================

export interface TimelyLabel {
    id: number;
    name: string;
    sequence: number;
    parent_id: number | null;
    emoji: string | null;
    children: TimelyLabel[];
}

// ============================================
// Project
// ============================================

export interface TimelyProject {
    id: number;
    active: boolean;
    account_id: number;
    name: string;
    description: string;
    color: string;
    rate_type: string;
    billable: boolean;
    created_at: number;
    updated_at: number;
    external_id: string | null;
    budget_scope: string | null;
    client: TimelyClient | null;
    required_notes: boolean;
    required_labels: boolean;
    budget_expired_on: string | null;
    has_recurrence: boolean;
    enable_labels: string;
    default_labels: boolean;
    currency: Currency;
    team_ids: number[];
    budget: number;
    budget_type: string;
    budget_calculation: string;
    hour_rate: number;
    hour_rate_in_cents: number;
    budget_progress: number;
    budget_percent: number;
    invoice_by_budget: boolean;
    labels: TimelyLabel[];
    label_ids: number[];
    required_label_ids: number[];
    default_label_ids: number[];
    created_from: string;
}

// ============================================
// User
// ============================================

export interface TimelyUser {
    id: number;
    email: string;
    name: string;
    avatar: Avatar;
    updated_at: string;
}

// ============================================
// Event (Time Entry)
// ============================================

export interface TimelyEvent {
    id: number;
    uid: string;
    user: TimelyUser;
    project: TimelyProject;
    duration: Duration;
    estimated_duration: Duration;
    cost: Cost;
    estimated_cost: Cost;
    day: string; // YYYY-MM-DD
    note: string;
    sequence: number;
    estimated: boolean;
    timer_state: string;
    timer_started_on: number;
    timer_stopped_on: number;
    label_ids: number[];
    user_ids: number[];
    updated_at: number;
    created_at: number;
    created_from: string;
    updated_from: string;
    billed: boolean;
    billable: boolean;
    to: string;
    from: string;
    deleted: boolean;
    hour_rate: number;
    hour_rate_in_cents: number;
    creator_id: number | null;
    updater_id: number | null;
    external_id: string | null;
    entry_ids: number[];
    suggestion_id: number | null;
    draft: boolean;
    manage: boolean;
    forecast_id: number | null;
    billed_at: string | null;
    locked_reason: string | null;
    locked: boolean;
    invoice_id: number | null;
    timestamps: unknown[];
    state: string | null;
    external_links: unknown[];
}

// ============================================
// Create Event Input
// ============================================

export interface CreateEventInput {
    day: string; // YYYY-MM-DD
    hours: number;
    minutes: number;
    note?: string;
    project_id?: number;
    user_id?: number;
    from?: string; // HH:MM
    to?: string; // HH:MM
    estimated_hours?: number;
    estimated_minutes?: number;
    label_ids?: number[];
    external_id?: string;
}

// ============================================
// API Responses
// ============================================

export interface PaginatedResponse<T> {
    data: T[];
    page: number;
    per_page: number;
    total_pages: number;
    total_count: number;
}
```

### CLI Types (`types/cli.ts`)

```typescript
// src/timely/types/cli.ts

export interface TimelyArgs {
    _: string[]; // Positional arguments (command, subcommand)
    help?: boolean;
    verbose?: boolean;
    format?: "json" | "table" | "csv";

    // Account/project overrides
    account?: number;
    project?: number;

    // Date filters
    since?: string; // YYYY-MM-DD
    upto?: string; // YYYY-MM-DD
    day?: string; // YYYY-MM-DD
    month?: string; // YYYY-MM

    // Interactive flags
    select?: boolean; // For accounts/projects commands

    // Output control
    output?: string; // Output file path
    clipboard?: boolean; // Copy to clipboard
}
```

### Type Index (`types/index.ts`)

```typescript
// src/timely/types/index.ts

export * from "./config";
export * from "./api";
export * from "./cli";
```

---

## Part 4: API Client (`api/client.ts`)

```typescript
// src/timely/api/client.ts

import { Storage } from "@app/utils/storage";
import logger from "@app/logger";
import type { OAuth2Tokens, TimelyConfig } from "../types";

export interface RequestOptions {
    params?: Record<string, string | number | boolean>;
    headers?: Record<string, string>;
    skipAuth?: boolean;
}

export class TimelyApiClient {
    private baseUrl = "https://api.timelyapp.com/1.1";
    private storage: Storage;

    constructor(storage: Storage) {
        this.storage = storage;
    }

    // ============================================
    // Authentication
    // ============================================

    /**
     * Check if user is authenticated (has valid tokens)
     */
    async isAuthenticated(): Promise<boolean> {
        const tokens = await this.storage.getConfigValue<OAuth2Tokens>("tokens");
        return !!tokens?.access_token;
    }

    /**
     * Get valid access token, refreshing if necessary
     */
    private async getAccessToken(): Promise<string> {
        const tokens = await this.storage.getConfigValue<OAuth2Tokens>("tokens");
        if (!tokens?.access_token) {
            throw new Error("Not authenticated. Run 'tools timely login' first.");
        }

        // Check if token is expired (with 5 minute buffer)
        if (tokens.created_at && tokens.expires_in) {
            const expiresAt = (tokens.created_at + tokens.expires_in) * 1000;
            const bufferMs = 5 * 60 * 1000; // 5 minutes

            if (Date.now() > expiresAt - bufferMs) {
                logger.debug("Access token expired, refreshing...");
                const newTokens = await this.refreshToken(tokens.refresh_token);
                return newTokens.access_token;
            }
        }

        return tokens.access_token;
    }

    /**
     * Refresh the access token using refresh_token
     */
    private async refreshToken(refreshToken: string): Promise<OAuth2Tokens> {
        const oauth = await this.storage.getConfigValue<{ client_id: string; client_secret: string }>("oauth");
        if (!oauth) {
            throw new Error("OAuth application credentials not found. Run 'tools timely login' first.");
        }

        const response = await fetch("https://api.timelyapp.com/1.1/oauth/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: oauth.client_id,
                client_secret: oauth.client_secret,
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token refresh failed: ${error}`);
        }

        const tokens = (await response.json()) as OAuth2Tokens;

        // Update stored tokens
        await this.storage.setConfigValue("tokens", {
            ...tokens,
            created_at: Math.floor(Date.now() / 1000),
        });

        logger.debug("Access token refreshed successfully");
        return tokens;
    }

    /**
     * Exchange authorization code for tokens
     */
    async exchangeCode(code: string): Promise<OAuth2Tokens> {
        const oauth = await this.storage.getConfigValue<{
            client_id: string;
            client_secret: string;
            redirect_uri: string;
        }>("oauth");
        if (!oauth) {
            throw new Error("OAuth application credentials not configured");
        }

        const response = await fetch("https://api.timelyapp.com/1.1/oauth/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                grant_type: "authorization_code",
                code,
                client_id: oauth.client_id,
                client_secret: oauth.client_secret,
                redirect_uri: oauth.redirect_uri,
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token exchange failed: ${error}`);
        }

        const tokens = (await response.json()) as OAuth2Tokens;

        // Store tokens with timestamp
        await this.storage.setConfigValue("tokens", {
            ...tokens,
            created_at: Math.floor(Date.now() / 1000),
        });

        return tokens;
    }

    // ============================================
    // HTTP Methods
    // ============================================

    /**
     * Make an authenticated request
     */
    private async request<T>(
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        body?: unknown,
        options: RequestOptions = {}
    ): Promise<T> {
        const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path}`);

        // Add query parameters
        if (options.params) {
            for (const [key, value] of Object.entries(options.params)) {
                if (value !== undefined && value !== null) {
                    url.searchParams.set(key, String(value));
                }
            }
        }

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...options.headers,
        };

        // Add authorization header unless skipped
        if (!options.skipAuth) {
            const token = await this.getAccessToken();
            headers["Authorization"] = `Bearer ${token}`;
        }

        logger.debug(`${method} ${url.toString()}`);

        const response = await fetch(url.toString(), {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`API request failed (${response.status}): ${error}`);
        }

        // Handle empty responses
        const text = await response.text();
        if (!text) {
            return {} as T;
        }

        return JSON.parse(text) as T;
    }

    /**
     * GET request
     */
    async get<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
        return this.request<T>("GET", path, undefined, { params });
    }

    /**
     * POST request
     */
    async post<T>(path: string, body: unknown): Promise<T> {
        return this.request<T>("POST", path, body);
    }

    /**
     * PUT request
     */
    async put<T>(path: string, body: unknown): Promise<T> {
        return this.request<T>("PUT", path, body);
    }

    /**
     * DELETE request
     */
    async delete<T>(path: string): Promise<T> {
        return this.request<T>("DELETE", path);
    }
}
```

### TimelyService Class (`api/service.ts`)

```typescript
// src/timely/api/service.ts

import type { TimelyApiClient } from "./client";
import type { TimelyAccount, TimelyProject, TimelyEvent, TimelyUser, CreateEventInput } from "../types";

export interface GetEventsParams {
    since?: string; // YYYY-MM-DD
    upto?: string; // YYYY-MM-DD
    day?: string; // YYYY-MM-DD (single day)
    page?: number;
    per_page?: number;
    sort?: "updated_at" | "id" | "day";
    order?: "asc" | "desc";
}

/**
 * TimelyService provides all API endpoint methods
 * Wraps TimelyApiClient with convenient methods for accounts, projects, events, etc.
 */
export class TimelyService {
    constructor(private client: TimelyApiClient) {}

    // ============================================
    // Accounts
    // ============================================

    /**
     * Get all accounts for the authenticated user
     */
    async getAccounts(): Promise<TimelyAccount[]> {
        return this.client.get<TimelyAccount[]>("/accounts");
    }

    /**
     * Get a specific account by ID
     */
    async getAccount(accountId: number): Promise<TimelyAccount> {
        return this.client.get<TimelyAccount>(`/accounts/${accountId}`);
    }

    // ============================================
    // Projects
    // ============================================

    /**
     * Get all projects for an account
     */
    async getProjects(accountId: number): Promise<TimelyProject[]> {
        return this.client.get<TimelyProject[]>(`/${accountId}/projects`);
    }

    /**
     * Get a specific project
     */
    async getProject(accountId: number, projectId: number): Promise<TimelyProject> {
        return this.client.get<TimelyProject>(`/${accountId}/projects/${projectId}`);
    }

    // ============================================
    // Events
    // ============================================

    /**
     * Get events for an account
     */
    async getEvents(accountId: number, params: GetEventsParams = {}): Promise<TimelyEvent[]> {
        return this.client.get<TimelyEvent[]>(`/${accountId}/events`, {
            ...params,
            per_page: params.per_page ?? 100,
        });
    }

    /**
     * Get all events for a date range (handles pagination)
     */
    async getAllEvents(accountId: number, params: GetEventsParams): Promise<TimelyEvent[]> {
        const allEvents: TimelyEvent[] = [];
        let page = 1;
        const perPage = 100;

        while (true) {
            const events = await this.getEvents(accountId, {
                ...params,
                page,
                per_page: perPage,
            });

            allEvents.push(...events);

            if (events.length < perPage) {
                break; // No more pages
            }

            page++;
        }

        return allEvents;
    }

    /**
     * Create a new event
     */
    async createEvent(accountId: number, event: CreateEventInput): Promise<TimelyEvent> {
        return this.client.post<TimelyEvent>(`/${accountId}/events`, { event });
    }

    // ============================================
    // Users
    // ============================================

    /**
     * Get all users for an account
     */
    async getUsers(accountId: number): Promise<TimelyUser[]> {
        return this.client.get<TimelyUser[]>(`/${accountId}/users`);
    }

    /**
     * Get a specific user
     */
    async getUser(accountId: number, userId: number): Promise<TimelyUser> {
        return this.client.get<TimelyUser>(`/${accountId}/users/${userId}`);
    }
}
```

### API Index (`api/index.ts`)

```typescript
// src/timely/api/index.ts

export { TimelyApiClient } from "./client";
export { TimelyService } from "./service";
export type { GetEventsParams } from "./service";
```

---

## Part 5: Commands

### Login Command (`commands/login.ts`)

```typescript
// src/timely/commands/login.ts

import { input, confirm, password } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyApiClient } from "../api/client";
import type { TimelyArgs, OAuthApplication } from "../types";

export async function loginCommand(
    args: TimelyArgs,
    storage: Storage,
    client: TimelyApiClient,
    service: TimelyService
): Promise<void> {
    // Check if already logged in
    if (await client.isAuthenticated()) {
        const { confirm } = (await prompter.prompt({
            type: "confirm",
            name: "confirm",
            message: "You are already logged in. Do you want to re-authenticate?",
            initial: false,
        })) as { confirm: boolean };

        if (!confirm) {
            logger.info("Login cancelled.");
            return;
        }
    }

    // Get or prompt for OAuth credentials
    let oauth = await storage.getConfigValue<OAuthApplication>("oauth");

    if (!oauth?.client_id || !oauth?.client_secret) {
        logger.info(chalk.yellow("\nOAuth application credentials not found."));
        logger.info("Create an OAuth application at: https://app.timelyapp.com/settings/oauth_applications\n");

        const { clientId, clientSecret, redirectUri } = (await prompter.prompt([
            {
                type: "input",
                name: "clientId",
                message: "Client ID:",
            },
            {
                type: "password",
                name: "clientSecret",
                message: "Client Secret:",
            },
            {
                type: "input",
                name: "redirectUri",
                message: "Redirect URI (press Enter for default):",
                initial: "urn:ietf:wg:oauth:2.0:oob",
            },
        ])) as { clientId: string; clientSecret: string; redirectUri: string };

        oauth = {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
        };

        await storage.setConfigValue("oauth", oauth);
    }

    // Build authorization URL
    const authUrl = new URL("https://api.timelyapp.com/1.1/oauth/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", oauth.client_id);
    authUrl.searchParams.set("redirect_uri", oauth.redirect_uri);

    logger.info(chalk.cyan("\nOpen this URL in your browser to authorize:"));
    logger.info(chalk.white(authUrl.toString()) + "\n");

    // Try to open browser automatically
    try {
        const proc = Bun.spawn({
            cmd: ["open", authUrl.toString()],
            stdio: ["ignore", "ignore", "ignore"],
        });
        await proc.exited;
    } catch {
        // Ignore if open command fails
    }

    // Prompt for authorization code
    const { code } = (await prompter.prompt({
        type: "input",
        name: "code",
        message: "Paste the authorization code:",
    })) as { code: string };

    // Exchange code for tokens
    logger.info(chalk.yellow("Exchanging code for tokens..."));

    try {
        const tokens = await client.exchangeCode(code.trim());
        logger.info(chalk.green("Successfully authenticated!"));
        logger.debug(`Access token: ${tokens.access_token.substring(0, 10)}...`);
    } catch (error) {
        logger.error(`Login failed: ${error}`);
        throw error;
    }
}
```

### Logout Command (`commands/logout.ts`)

```typescript
// src/timely/commands/logout.ts

import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyApiClient } from "../api/client";
import { TimelyService } from "../api/service";
import type { TimelyArgs, TimelyConfig } from "../types";

export async function logoutCommand(
    args: TimelyArgs,
    storage: Storage,
    client: TimelyApiClient,
    service: TimelyService
): Promise<void> {
    // Clear tokens from config
    const config = (await storage.getConfig<TimelyConfig>()) || {};
    delete config.tokens;
    delete config.user;

    await storage.setConfig(config);

    logger.info(chalk.green("Logged out successfully."));
}
```

### Accounts Command (`commands/accounts.ts`)

```typescript
// src/timely/commands/accounts.ts

import { select } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyService } from "../api/service";
import type { TimelyArgs, TimelyAccount } from "../types";

export async function accountsCommand(args: TimelyArgs, storage: Storage, service: TimelyService): Promise<void> {
    // Fetch accounts
    logger.info(chalk.yellow("Fetching accounts..."));
    const accounts = await service.getAccounts();

    if (accounts.length === 0) {
        logger.info("No accounts found.");
        return;
    }

    // Get currently selected account
    const selectedId = await storage.getConfigValue<number>("selectedAccountId");

    // Display accounts
    if (args.format === "json") {
        console.log(JSON.stringify(accounts, null, 2));
        return;
    }

    logger.info(chalk.cyan(`\nFound ${accounts.length} account(s):\n`));

    for (const account of accounts) {
        const selected = account.id === selectedId ? chalk.green(" (selected)") : "";
        const status = account.expired ? chalk.red("[expired]") : account.trial ? chalk.yellow("[trial]") : "";
        console.log(`  ${chalk.bold(account.name)} (ID: ${account.id}) ${status}${selected}`);
        console.log(`    Plan: ${account.plan_name}`);
        console.log(`    Users: ${account.num_users}/${account.max_users}`);
        console.log(`    Projects: ${account.active_projects_count}/${account.max_projects}`);
        console.log();
    }

    // Interactive selection
    if (args.select || !selectedId) {
        const choices = accounts.map((a) => ({
            name: a.id.toString(),
            message: `${a.name} (${a.plan_name})`,
        }));

        const { accountId } = (await prompter.prompt({
            type: "select",
            name: "accountId",
            message: "Select default account:",
            choices,
        })) as { accountId: string };

        await storage.setConfigValue("selectedAccountId", parseInt(accountId, 10));
        logger.info(chalk.green(`Default account set to ID: ${accountId}`));
    }
}
```

### Projects Command (`commands/projects.ts`)

```typescript
// src/timely/commands/projects.ts

import { select } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyService } from "../api/service";
import type { TimelyArgs, TimelyProject } from "../types";

export async function projectsCommand(args: TimelyArgs, storage: Storage, service: TimelyService): Promise<void> {
    // Get account ID
    const accountId = args.account || (await storage.getConfigValue<number>("selectedAccountId"));
    if (!accountId) {
        logger.error("No account selected. Run 'tools timely accounts --select' first.");
        process.exit(1);
    }

    // Fetch projects
    logger.info(chalk.yellow("Fetching projects..."));
    const projects = await service.getProjects(accountId);

    if (projects.length === 0) {
        logger.info("No projects found.");
        return;
    }

    // Output based on format
    if (args.format === "json") {
        console.log(JSON.stringify(projects, null, 2));
        return;
    }

    // Get currently selected project
    const selectedId = await storage.getConfigValue<number>("selectedProjectId");

    logger.info(chalk.cyan(`\nFound ${projects.length} project(s):\n`));

    // Group by client
    const byClient = new Map<string, TimelyProject[]>();
    for (const project of projects) {
        const clientName = project.client?.name || "No Client";
        if (!byClient.has(clientName)) {
            byClient.set(clientName, []);
        }
        byClient.get(clientName)!.push(project);
    }

    for (const [clientName, clientProjects] of byClient) {
        console.log(chalk.bold(clientName));
        for (const project of clientProjects) {
            const selected = project.id === selectedId ? chalk.green(" (selected)") : "";
            const status = project.active ? "" : chalk.gray("[inactive]");
            console.log(`  ${project.name} (ID: ${project.id}) ${status}${selected}`);
        }
        console.log();
    }

    // Interactive selection
    if (args.select) {
        const choices = projects
            .filter((p) => p.active)
            .map((p) => ({
                name: p.id.toString(),
                message: `${p.name}${p.client ? ` (${p.client.name})` : ""}`,
            }));

        const { projectId } = (await prompter.prompt({
            type: "select",
            name: "projectId",
            message: "Select default project:",
            choices,
        })) as { projectId: string };

        await storage.setConfigValue("selectedProjectId", parseInt(projectId, 10));
        logger.info(chalk.green(`Default project set to ID: ${projectId}`));
    }
}
```

### Export Month Command (`commands/export-month.ts`)

```typescript
// src/timely/commands/export-month.ts

import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyService } from "../api/service";
import { getMonthDateRange, formatDuration } from "../utils/date";
import type { TimelyArgs, TimelyEvent } from "../types";

export async function exportMonthCommand(args: TimelyArgs, storage: Storage, service: TimelyService): Promise<void> {
    // Parse month argument (YYYY-MM)
    const monthArg = args.month || args._[1];
    if (!monthArg || !/^\d{4}-\d{2}$/.test(monthArg)) {
        logger.error("Please provide a month in YYYY-MM format.");
        logger.info("Example: tools timely export-month 2025-11");
        process.exit(1);
    }

    // Get account ID
    const accountId = args.account || (await storage.getConfigValue<number>("selectedAccountId"));
    if (!accountId) {
        logger.error("No account selected. Run 'tools timely accounts --select' first.");
        process.exit(1);
    }

    // Calculate date range
    const { since, upto } = getMonthDateRange(monthArg);
    logger.info(chalk.yellow(`Fetching events for ${monthArg} (${since} to ${upto})...`));

    // Use caching with TTL
    const cacheKey = `events/${accountId}/${monthArg}.json`;

    // Use shorter TTL for current/recent months
    const currentMonth = new Date().toISOString().substring(0, 7);
    const ttl = monthArg === currentMonth ? "1 hour" : "7 days";

    const events = await storage.getFileOrPut<TimelyEvent[]>(
        cacheKey,
        () => service.getAllEvents(accountId, { since, upto }),
        ttl
    );

    if (events.length === 0) {
        logger.info("No events found for this month.");
        return;
    }

    // Output based on format
    if (args.format === "json") {
        console.log(JSON.stringify(events, null, 2));
        return;
    }

    if (args.format === "csv") {
        // CSV output
        console.log("date,project,note,hours,minutes,duration_formatted");
        for (const event of events) {
            console.log(
                [
                    event.day,
                    `"${event.project?.name || "No Project"}"`,
                    `"${event.note.replace(/"/g, '""')}"`,
                    event.duration.hours,
                    event.duration.minutes,
                    event.duration.formatted,
                ].join(",")
            );
        }
        return;
    }

    // Table output (default)
    logger.info(chalk.cyan(`\nFound ${events.length} event(s) for ${monthArg}:\n`));

    // Group by day
    const byDay = new Map<string, TimelyEvent[]>();
    for (const event of events) {
        if (!byDay.has(event.day)) {
            byDay.set(event.day, []);
        }
        byDay.get(event.day)!.push(event);
    }

    // Sort days
    const sortedDays = Array.from(byDay.keys()).sort();

    let totalSeconds = 0;

    for (const day of sortedDays) {
        const dayEvents = byDay.get(day)!;
        const dayTotal = dayEvents.reduce((sum, e) => sum + e.duration.total_seconds, 0);
        totalSeconds += dayTotal;

        console.log(chalk.bold(`${day} (${formatDuration(dayTotal)})`));

        for (const event of dayEvents) {
            const project = event.project?.name || "No Project";
            const note = event.note.substring(0, 50) + (event.note.length > 50 ? "..." : "");
            console.log(`  ${event.duration.formatted.padStart(8)} | ${project.padEnd(20)} | ${note}`);
        }
        console.log();
    }

    // Summary
    console.log(chalk.cyan("─".repeat(60)));
    console.log(chalk.bold(`Total: ${formatDuration(totalSeconds)}`));
    console.log(`Events: ${events.length}`);
    console.log(`Days: ${sortedDays.length}`);
}
```

### Status Command (`commands/status.ts`)

```typescript
// src/timely/commands/status.ts

import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyApiClient } from "../api/client";
import { TimelyService } from "../api/service";
import type { TimelyArgs, TimelyConfig } from "../types";

export async function statusCommand(
    args: TimelyArgs,
    storage: Storage,
    client: TimelyApiClient,
    service: TimelyService
): Promise<void> {
    const config = await storage.getConfig<TimelyConfig>();

    if (args.format === "json") {
        // Mask sensitive data
        const safeConfig = {
            ...config,
            oauth: config?.oauth ? { ...config.oauth, client_secret: "***" } : undefined,
            tokens: config?.tokens ? { ...config.tokens, access_token: "***", refresh_token: "***" } : undefined,
        };
        console.log(JSON.stringify(safeConfig, null, 2));
        return;
    }

    console.log(chalk.cyan("\nTimely CLI Status\n"));

    // Authentication status
    const isAuth = await client.isAuthenticated();
    console.log(`Authentication: ${isAuth ? chalk.green("Logged in") : chalk.red("Not logged in")}`);

    if (config?.user) {
        console.log(`User: ${config.user.name} (${config.user.email})`);
    }

    if (config?.tokens?.created_at && config?.tokens?.expires_in) {
        const expiresAt = new Date((config.tokens.created_at + config.tokens.expires_in) * 1000);
        const isExpired = Date.now() > expiresAt.getTime();
        console.log(`Token expires: ${expiresAt.toISOString()} ${isExpired ? chalk.red("(expired)") : ""}`);
    }

    // Selected account/project
    console.log();
    console.log(`Selected Account ID: ${config?.selectedAccountId || chalk.gray("(none)")}`);
    console.log(`Selected Project ID: ${config?.selectedProjectId || chalk.gray("(none)")}`);

    // Cache stats
    const cacheStats = await storage.getCacheStats();
    console.log();
    console.log(`Cache files: ${cacheStats.count}`);
    console.log(`Cache size: ${(cacheStats.totalSizeBytes / 1024).toFixed(1)} KB`);

    // Config location
    console.log();
    console.log(chalk.gray(`Config: ${storage.getConfigPath()}`));
    console.log(chalk.gray(`Cache: ${storage.getCacheDir()}`));
}
```

### Cache Command (`commands/cache.ts`)

```typescript
// src/timely/commands/cache.ts

import { confirm } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyApiClient } from "../api/client";
import { TimelyService } from "../api/service";
import type { TimelyArgs } from "../types";

export async function cacheCommand(
    args: TimelyArgs,
    storage: Storage,
    client: TimelyApiClient,
    service: TimelyService
): Promise<void> {
    const subcommand = args._[1];

    switch (subcommand) {
        case "list": {
            const files = await storage.listCacheFiles();
            if (files.length === 0) {
                logger.info("Cache is empty.");
                return;
            }

            if (args.format === "json") {
                console.log(JSON.stringify(files, null, 2));
                return;
            }

            logger.info(chalk.cyan(`\nCached files (${files.length}):\n`));
            for (const file of files) {
                console.log(`  ${file}`);
            }
            break;
        }

        case "clear": {
            const stats = await storage.getCacheStats();
            if (stats.count === 0) {
                logger.info("Cache is already empty.");
                return;
            }

            const { confirm } = (await prompter.prompt({
                type: "confirm",
                name: "confirm",
                message: `Delete ${stats.count} cached files (${(stats.totalSizeBytes / 1024).toFixed(1)} KB)?`,
                initial: false,
            })) as { confirm: boolean };

            if (confirm) {
                await storage.clearCache();
                logger.info(chalk.green("Cache cleared."));
            } else {
                logger.info("Cancelled.");
            }
            break;
        }

        default:
            logger.info(`
Usage: tools timely cache <subcommand>

Subcommands:
  list    List all cached files
  clear   Clear the cache
`);
    }
}
```

---

## Part 6: Main Entry Point (`index.ts`)

```typescript
#!/usr/bin/env bun

// src/timely/index.ts

import { Command } from "commander";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyApiClient } from "./api/client";
import { TimelyService } from "./api/service";
import type { TimelyArgs } from "./types";

// Commands
import { loginCommand } from "./commands/login";
import { logoutCommand } from "./commands/logout";
import { statusCommand } from "./commands/status";
import { accountsCommand } from "./commands/accounts";
import { projectsCommand } from "./commands/projects";
import { eventsCommand } from "./commands/events";
import { exportMonthCommand } from "./commands/export-month";
import { cacheCommand } from "./commands/cache";

type CommandHandler = (
    args: TimelyArgs,
    storage: Storage,
    client: TimelyApiClient,
    service: TimelyService
) => Promise<void>;

const COMMANDS: Record<string, CommandHandler> = {
    login: loginCommand,
    logout: logoutCommand,
    status: statusCommand,
    accounts: accountsCommand,
    projects: projectsCommand,
    events: eventsCommand,
    "export-month": exportMonthCommand,
    cache: cacheCommand,
};

function showHelp(): void {
    console.log(`
${chalk.bold("Timely CLI")} - Interact with Timely time tracking

${chalk.cyan("Usage:")}
  tools timely <command> [options]

${chalk.cyan("Commands:")}
  login                   Authenticate with Timely via OAuth2
  logout                  Clear stored authentication tokens
  status                  Show current configuration and auth status
  accounts                List all accounts (--select to choose default)
  projects                List all projects (--select to choose default)
  events                  List time entries
  export-month <YYYY-MM>  Export all entries for a month
  cache [list|clear]      Manage cache

${chalk.cyan("Global Options:")}
  -h, --help              Show this help message
  -v, --verbose           Enable verbose output
  -f, --format <format>   Output format: json, table, csv (default: table)
  -a, --account <id>      Override account ID
  -p, --project <id>      Override project ID

${chalk.cyan("Date Options (for events command):")}
  --since <YYYY-MM-DD>    Start date
  --upto <YYYY-MM-DD>     End date
  --day <YYYY-MM-DD>      Single day

${chalk.cyan("Examples:")}
  tools timely login
  tools timely accounts --select
  tools timely projects
  tools timely events --since 2025-11-01 --upto 2025-11-30
  tools timely export-month 2025-11
  tools timely export-month 2025-11 --format csv > time.csv
  tools timely cache clear
`);
}

// Note: The actual implementation uses commander for argument parsing
// Example structure:
// const program = new Command();
// program
//     .name('timely')
//     .option('-v, --verbose', 'Enable verbose output')
//     .option('-f, --format <format>', 'Output format')
//     ...
// program.command('login').action(loginCommand);
// program.parse();

async function main(): Promise<void> {
    // Using commander for argument parsing (simplified for plan doc)
    const args = {
        // Commander parsed options would be here
        verbose: false,
        format: "table",
        string: ["format", "since", "upto", "day", "month", "output"],
    });

    // Show help if requested or no command
    if (args.help || args._.length === 0) {
        showHelp();
        process.exit(0);
    }

    const command = args._[0];

    // Check if command exists
    if (!(command in COMMANDS)) {
        logger.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }

    // Initialize storage, client, and service
    const storage = new Storage("timely");
    await storage.ensureDirs();

    const client = new TimelyApiClient(storage);
    const service = new TimelyService(client);

    // Execute command
    try {
        await COMMANDS[command](args, storage, client, service);
    } catch (error) {
        if (error instanceof Error && (error.message === "canceled" || error.message === "")) {
            logger.info("\nOperation cancelled.");
            process.exit(0);
        }
        logger.error(`Command failed: ${error}`);
        if (args.verbose) {
            console.error(error);
        }
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
```

---

## Part 7: Utility Functions

### Date Utilities (`utils/date.ts`)

```typescript
// src/timely/utils/date.ts

/**
 * Get the date range for a given month (YYYY-MM)
 * @param month - Month in YYYY-MM format
 * @returns Object with since (first day) and upto (last day)
 */
export function getMonthDateRange(month: string): { since: string; upto: string } {
    const [year, monthNum] = month.split("-").map(Number);

    // First day of month
    const since = `${year}-${String(monthNum).padStart(2, "0")}-01`;

    // Last day of month
    const lastDay = new Date(year, monthNum, 0).getDate();
    const upto = `${year}-${String(monthNum).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    return { since, upto };
}

/**
 * Format total seconds as "Xh Ym"
 */
export function formatDuration(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

/**
 * Get all dates in a month
 * @param month - Month in YYYY-MM format
 * @returns Array of dates in YYYY-MM-DD format
 */
export function getDatesInMonth(month: string): string[] {
    const { since, upto } = getMonthDateRange(month);
    const dates: string[] = [];

    const start = new Date(since);
    const end = new Date(upto);

    const current = new Date(start);
    while (current <= end) {
        dates.push(current.toISOString().split("T")[0]);
        current.setDate(current.getDate() + 1);
    }

    return dates;
}
```

---

## Part 8: Implementation Phases

### Phase 1: Storage Utility (Foundation)

1. Create `src/utils/storage/` directory structure
2. Implement `Storage` class with all methods
3. Create index.ts re-export
4. Test manually with a simple script

### Phase 2: Timely Types & Directory Structure

1. Create `src/timely/` directory structure
2. Define all TypeScript interfaces in `types/`
3. Create index.ts re-exports

### Phase 3: API Client & Service

1. Implement `TimelyApiClient` class
2. Implement `TimelyService` class with all API endpoints
3. Test API connectivity manually

### Phase 4: Authentication Commands

1. Implement `login` command (OAuth2 flow)
2. Implement `logout` command
3. Implement `status` command
4. Test full auth flow

### Phase 5: Data Commands

1. Implement `accounts` command
2. Implement `projects` command
3. Implement `events` command
4. Test with real data

### Phase 6: Export & Caching

1. Implement `export-month` command with caching
2. Implement `cache` command
3. Test caching behavior

### Phase 7: Polish & Documentation

1. Add better error messages
2. Add CSV/JSON output support
3. Test all commands end-to-end
4. Update CLAUDE.md with timely-specific notes

---

## Critical Files for Implementation

1. **`src/utils/storage/storage.ts`** - Core reusable storage utility
2. **`src/timely/index.ts`** - Main CLI entry point
3. **`src/timely/api/client.ts`** - API client with OAuth2 handling
4. **`src/timely/api/service.ts`** - TimelyService class with all API endpoints
5. **`src/timely/commands/login.ts`** - OAuth2 authentication flow
6. **`src/timely/types/api.ts`** - All Timely API response types

---

## Usage Examples After Implementation

```bash
# First-time setup
tools timely login
tools timely accounts --select
tools timely projects

# View status
tools timely status

# List events for a date range
tools timely events --since 2025-11-01 --upto 2025-11-30

# Export month's data
tools timely export-month 2025-11
tools timely export-month 2025-11 --format json > november.json
tools timely export-month 2025-11 --format csv > november.csv

# Cache management
tools timely cache list
tools timely cache clear
```

---

## Existing Patterns Found in Codebase

The Plan agent found these useful patterns:

1. **`src/ask/output/UsageDatabase.ts`** - Uses `~/.genesis-tools/` for tool-specific storage
2. **`src/ask/`** - Complex CLI with multiple commands, providers, and managers
3. **`src/git-commit/`** - Simple CLI with Enquirer prompts and Bun.spawn
4. **Logger** - Use `@app/logger` for consistent logging
5. **Path aliases** - `@app/*` maps to `src/*`, `@ask/*` maps to `src/ask/*`
