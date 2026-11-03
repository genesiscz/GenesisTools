import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { showsInUsageDashboard } from "@genesiscz/utils/ai/config/selectors";
import type { AccountKey, UsageWarning } from "@genesiscz/utils/ai/usage/contract/envelope";
import type { SnapshotsCache } from "./legacy-cache";
import type { AccountUsageSnapshot } from "./types";

/** `usage.limits@1`: the verb and its shape version. */
export const LIMITS_NOW_SCHEMA = { verb: "limits", version: 1 } as const;

/** A snapshot as it may cross a wire: the provider-private `native` payload never does. */
export type WireAccountUsageSnapshot = Omit<AccountUsageSnapshot, "native">;

export interface LimitsNowData {
    accounts: WireAccountUsageSnapshot[];
}

function keyOf(account: AccountEntry): AccountKey {
    return { provider: account.provider, accountId: account.id, accountName: account.name };
}

/** Accounts a usage verb can name: configured, of a provider that reports quota. */
export function usageAccountKeys(
    accounts: readonly AccountEntry[],
    providerIds: readonly string[],
    opts: { visibleOnly: boolean }
): AccountKey[] {
    const wanted = new Set(providerIds);

    return accounts
        .filter((account) => wanted.has(account.provider))
        .filter((account) => !opts.visibleOnly || showsInUsageDashboard(account))
        .map(keyOf);
}

/** The all-provider cache file as one list, in the file's provider order. Never polls. */
export function snapshotsFromCache(cache: SnapshotsCache | null): AccountUsageSnapshot[] {
    return cache ? Object.values(cache.providers).flatMap((slice) => slice.accounts) : [];
}

function stripNative(snapshot: AccountUsageSnapshot): WireAccountUsageSnapshot {
    const { native: _native, ...rest } = snapshot;
    return rest;
}

export interface LimitsNowRequest {
    /** Plugin ids. Omitted: every provider. */
    providers?: readonly string[];
    /** Omitted: every account the snapshots name. */
    accounts?: readonly AccountKey[];
}

/**
 * Every account's windows now (`tools ai usage limits`): the snapshots narrowed to the request,
 * `native` removed. A selected account the snapshots do not name is a warning, so an empty
 * answer never reads as "no usage".
 */
export function limitsNow(
    snapshots: readonly AccountUsageSnapshot[],
    request: LimitsNowRequest
): { data: LimitsNowData; warnings: UsageWarning[] } {
    const providers = request.providers ? new Set(request.providers) : undefined;
    const selected = request.accounts
        ? new Set(request.accounts.map((account) => `${account.provider}\u0000${account.accountId}`))
        : undefined;
    const accounts = snapshots
        .filter((snapshot) => !providers || providers.has(snapshot.provider))
        .filter((snapshot) => !selected || selected.has(`${snapshot.provider}\u0000${snapshot.accountId}`))
        .map(stripNative);
    const present = new Set(accounts.map((snapshot) => `${snapshot.provider}\u0000${snapshot.accountId}`));
    const warnings: UsageWarning[] = (request.accounts ?? [])
        .filter((account) => !present.has(`${account.provider}\u0000${account.accountId}`))
        .map((account) => ({
            code: "account-missing",
            message: `${account.accountName} (${account.provider}) has no reading: it is hidden from the usage dashboard or was never polled.`,
        }));

    return { data: { accounts }, warnings };
}
