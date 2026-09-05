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

/** The only provider whose rounds keep the claude-only legacy file current. */
export const LEGACY_CACHE_PROVIDER = "anthropic-sub";

/**
 * One snapshot as the Swift decoder wants it. `native` is the untouched `UsageResponse`, so
 * this re-wraps rather than re-deriving from `LimitWindow[]`, and the epoch-ms timestamps the
 * decoder expects come back from the snapshot's ISO strings.
 */
function legacyRowFromSnapshot(snapshot: AccountUsageSnapshot): LegacyAccountInput {
    const refreshExpiresAt = snapshot.auth?.refreshExpiresAt
        ? new Date(snapshot.auth.refreshExpiresAt).getTime()
        : undefined;

    return {
        accountName: snapshot.accountName,
        ...(snapshot.label === undefined ? {} : { label: snapshot.label }),
        ...(snapshot.plan?.name === undefined ? {} : { subscriptionPlan: snapshot.plan.name }),
        ...(snapshot.plan?.status === undefined ? {} : { subscriptionStatus: snapshot.plan.status }),
        ...(snapshot.plan?.createdAt === undefined ? {} : { subscriptionCreatedAt: snapshot.plan.createdAt }),
        ...(snapshot.plan?.contradictedAt === undefined ? {} : { planContradictedAt: snapshot.plan.contradictedAt }),
        ...(refreshExpiresAt === undefined || Number.isNaN(refreshExpiresAt) ? {} : { refreshExpiresAt }),
        ...(snapshot.native === undefined ? {} : { usage: snapshot.native }),
        ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
        ...(snapshot.stale === undefined
            ? {}
            : {
                  stale: {
                      lastSuccessAt: new Date(snapshot.stale.lastSuccessAt).getTime(),
                      reason: snapshot.stale.reason,
                  },
              }),
        ...(snapshot.auth?.orgBlocked === undefined ? {} : { orgBlocked: snapshot.auth.orgBlocked }),
    };
}

/**
 * Keep the Genesis app's file current after a live `anthropic-sub` round (spec 6.4). Every
 * other provider is a no-op: the file is claude-only and one grok row in it makes the whole
 * thing wrong rather than richer.
 */
export async function projectRoundIntoLegacyCache(
    provider: string,
    snapshots: readonly AccountUsageSnapshot[],
    fetchedAt: number
): Promise<void> {
    if (provider !== LEGACY_CACHE_PROVIDER) {
        return;
    }

    await writeLegacyUsageShared(snapshots.map(legacyRowFromSnapshot), fetchedAt);
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

/**
 * Merges per provider: a caller that polled one provider (`tools claude usage` polls
 * anthropic only) replaces that provider's slice and keeps every other slice the file
 * already holds. Without the merge, the first anthropic-only poll after a daemon round
 * wiped codex and grok out of the file the dashboard and the Genesis app read.
 *
 * The read, the merge and the write run as ONE critical section under the storage file
 * lock. Two writers used to read the same `existing`, merge their own slice onto it and
 * write in turn, so the loser's slice was dropped from the merged result: the 30s daemon
 * racing a `tools claude usage` made the provider count alternate. `atomicUpdate` also
 * writes through a temp file and a rename, which `putCacheFile` does not, so a reader can
 * no longer catch a half-written file.
 *
 * The lock is NOT reentrant. Never call this from inside a lock on the same file.
 */
export async function writeSnapshotsCache(
    providers: Record<string, SnapshotsCacheProvider>,
    fetchedAt: Date = new Date()
): Promise<SnapshotsCache> {
    const fresh = Object.fromEntries(
        Object.entries(providers).map(([id, slice]) => [id, { ...slice, accounts: slice.accounts.map(stripNative) }])
    );

    // `atomicUpdate` reads the file with no TTL gate, unlike `readSnapshotsCache`.
    // Immaterial at USAGE_CACHE_TTL of 365 days, and the payload carries its own
    // `fetchedAt` for any reader that wants to judge age for itself.
    const payload = await usagePollStorage().atomicUpdate<SnapshotsCache>(SNAPSHOTS_CACHE_KEY, (current) => ({
        fetchedAt: fetchedAt.toISOString(),
        providers: { ...current?.providers, ...fresh },
    }));

    logger.debug({ providers: Object.keys(payload.providers) }, "[usage] all-provider snapshots cache written");

    return payload;
}

export async function readSnapshotsCache(): Promise<SnapshotsCache | null> {
    return (await usagePollStorage().getCacheFile<SnapshotsCache>(SNAPSHOTS_CACHE_KEY, USAGE_CACHE_TTL)) ?? null;
}
