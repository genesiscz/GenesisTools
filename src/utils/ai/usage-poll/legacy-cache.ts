import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { USAGE_CACHE_TTL, usagePollStorage } from "./storage";
import type { AccountUsageSnapshot } from "./types";

/**
 * The Genesis app reads `~/.genesis-tools/claude-usage/cache/usage-shared` directly
 * (`UsageCacheReader.swift:110-133`). The poll core's own cache moved to
 * `~/.genesis-tools/ai-usage/cache/snapshots:<provider>`, so this module keeps the old
 * file current after every live anthropic-sub fetch, in the exact shape the Swift decoder
 * expects (`UsageCacheReader.swift:151-277`), until Genesis switches to `snapshots.json`.
 *
 * Structural input types on purpose: `src/utils/**` must not import from `src/claude/**`.
 * The claude `AccountUsage` is assignable to `LegacyAccountInput`.
 */

const LEGACY_TOOL_NAME = "claude-usage";
const LEGACY_CACHE_KEY = "usage-shared";

export interface LegacyStaleInfo {
    lastSuccessAt: number;
    reason: string;
}

export interface LegacyAccountInput {
    accountName: string;
    label?: string;
    subscriptionCreatedAt?: string;
    subscriptionPlan?: string;
    subscriptionStatus?: string;
    planContradictedAt?: number;
    refreshExpiresAt?: number;
    usage?: unknown;
    error?: string;
    stale?: LegacyStaleInfo;
    orgBlocked?: boolean;
}

export interface LegacyUsageShared {
    fetchedAt: number;
    accounts: LegacyAccountInput[];
}

let legacyStorage: Storage | null = null;

function legacyStore(): Storage {
    if (!legacyStorage) {
        legacyStorage = new Storage(LEGACY_TOOL_NAME);
    }

    return legacyStorage;
}

/** Reset the memoised store. Tests move `GENESIS_TOOLS_HOME` between cases. */
export function __resetLegacyCacheStore(): void {
    legacyStorage = null;
}

export function legacyUsageSharedPath(): string {
    return join(legacyStore().getCacheDir(), LEGACY_CACHE_KEY);
}

/**
 * Whitelist the fields the Swift decoder reads. A row with no `accountName` is dropped:
 * the decoder requires it, and one nameless row makes the whole file undecodable.
 */
export function projectLegacyUsageShared(
    accounts: readonly LegacyAccountInput[],
    fetchedAt: number
): LegacyUsageShared {
    const projected: LegacyAccountInput[] = [];

    for (const account of accounts) {
        if (!account.accountName) {
            continue;
        }

        const row: LegacyAccountInput = { accountName: account.accountName };

        if (account.label !== undefined) {
            row.label = account.label;
        }

        if (account.subscriptionPlan !== undefined) {
            row.subscriptionPlan = account.subscriptionPlan;
        }

        if (account.subscriptionStatus !== undefined) {
            row.subscriptionStatus = account.subscriptionStatus;
        }

        if (account.subscriptionCreatedAt !== undefined) {
            row.subscriptionCreatedAt = account.subscriptionCreatedAt;
        }

        if (account.planContradictedAt !== undefined) {
            row.planContradictedAt = account.planContradictedAt;
        }

        if (account.refreshExpiresAt !== undefined) {
            row.refreshExpiresAt = account.refreshExpiresAt;
        }

        if (account.usage !== undefined) {
            row.usage = account.usage;
        }

        if (account.error !== undefined) {
            row.error = account.error;
        }

        if (account.stale !== undefined) {
            row.stale = account.stale;
        }

        if (account.orgBlocked !== undefined) {
            row.orgBlocked = account.orgBlocked;
        }

        projected.push(row);
    }

    return { fetchedAt, accounts: projected };
}

export async function writeLegacyUsageShared(
    accounts: readonly LegacyAccountInput[],
    fetchedAt: number = Date.now()
): Promise<void> {
    const payload = projectLegacyUsageShared(accounts, fetchedAt);
    await legacyStore().putCacheFile(LEGACY_CACHE_KEY, payload, USAGE_CACHE_TTL);
    logger.debug({ accounts: payload.accounts.length }, "[usage] legacy usage-shared cache written");
}

/** One provider's slice of the all-provider cache file (spec 6.4, amended 18:05). */
export interface SnapshotsCacheProvider {
    /** CLI alias: `claude`, `codex`, `grok`. */
    alias: string;
    /** `Claude`, `Codex`, `Grok`. */
    displayName: string;
    /** `AccountFeatures.presentation.prominentLimits`, so a reader needs no vocabulary. */
    prominent: string[];
    accounts: AccountUsageSnapshot[];
}

export interface SnapshotsCache {
    /** ISO-8601. */
    fetchedAt: string;
    providers: Record<string, SnapshotsCacheProvider>;
}

const SNAPSHOTS_CACHE_KEY = "snapshots.json";

/**
 * Absolute path of the all-provider cache file. Exported so no producer or reader
 * hardcodes a home directory.
 */
export function snapshotsCachePath(): string {
    return join(usagePollStorage().getCacheDir(), SNAPSHOTS_CACHE_KEY);
}

/** `native` is a provider-private payload; it never crosses a wire or a file boundary. */
function stripNative(snapshot: AccountUsageSnapshot): AccountUsageSnapshot {
    const { native: _native, ...rest } = snapshot;
    return rest;
}

export async function writeSnapshotsCache(
    providers: Record<string, SnapshotsCacheProvider>,
    fetchedAt: Date = new Date()
): Promise<SnapshotsCache> {
    const payload: SnapshotsCache = {
        fetchedAt: fetchedAt.toISOString(),
        providers: Object.fromEntries(
            Object.entries(providers).map(([id, slice]) => [
                id,
                { ...slice, accounts: slice.accounts.map(stripNative) },
            ])
        ),
    };

    await usagePollStorage().putCacheFile(SNAPSHOTS_CACHE_KEY, payload, USAGE_CACHE_TTL);
    logger.debug({ providers: Object.keys(payload.providers) }, "[usage] all-provider snapshots cache written");

    return payload;
}

export async function readSnapshotsCache(): Promise<SnapshotsCache | null> {
    return (await usagePollStorage().getCacheFile<SnapshotsCache>(SNAPSHOTS_CACHE_KEY, USAGE_CACHE_TTL)) ?? null;
}
