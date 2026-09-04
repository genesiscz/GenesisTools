import type { AccountUsageSnapshot, AiUsageResult } from "@app/dev-dashboard/contract/ai-accounts";
import { CLAUDE_ALL_ACCOUNT_ID } from "@app/dev-dashboard/contract/ai-accounts";
import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import type { SnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";

/**
 * Cache file to wire body. The file is keyed by plugin id and the wire is one flat
 * list, because a chart legend groups by account, not by provider. `native` was
 * already stripped when the file was written (`writeSnapshotsCache`), so nothing
 * provider-private can leak from here.
 */
export function flattenSnapshotsCache(cache: SnapshotsCache | null): AiUsageResult {
    if (!cache) {
        return { fetchedAt: new Date(0).toISOString(), snapshots: [] };
    }

    const snapshots: AccountUsageSnapshot[] = [];

    for (const slice of Object.values(cache.providers)) {
        snapshots.push(...slice.accounts);
    }

    return { fetchedAt: cache.fetchedAt, snapshots };
}

/**
 * Accept a CLI alias (`claude`) or a plugin id (`anthropic-sub`) and answer with the
 * plugin id. Unlike `resolveProviderAlias` this never throws: a dashboard filter is
 * user input, and an unknown provider must select nothing rather than 500 the route.
 */
export function resolveProviderFilter(input: string): string {
    return PROVIDER_ALIASES[input.trim().toLowerCase()] ?? input.trim();
}

export interface SnapshotFilter {
    /** Aliases or plugin ids. Empty or omitted means every provider. */
    providers?: readonly string[];
    /** Account ids or account names. Empty or omitted means every account. */
    accounts?: readonly string[];
}

export function filterSnapshots(
    snapshots: readonly AccountUsageSnapshot[],
    filter: SnapshotFilter
): AccountUsageSnapshot[] {
    const providers = filter.providers?.length ? new Set(filter.providers.map(resolveProviderFilter)) : undefined;
    const accounts = filter.accounts?.length ? new Set(filter.accounts) : undefined;

    return snapshots.filter((snapshot) => {
        if (providers && !providers.has(snapshot.provider)) {
            return false;
        }

        // Ids are what the UI sends; names are what a hand-typed query carries.
        return !accounts || accounts.has(snapshot.accountId) || accounts.has(snapshot.accountName);
    });
}

/**
 * The account ids a spend query may report. Both spend stores filter by account
 * id alone, so a provider filter must become a list of ids here or it does
 * nothing at all: the page read "0 accounts" while the spend widget still showed
 * every provider's money (sweep 2026-09-04, defect 10).
 *
 * `undefined` means "no filter". An EMPTY array means "the filter matched
 * nothing", which is a different answer and must not be read as "everything".
 */
export function spendAccountIds(
    filter: SnapshotFilter,
    enabled: ReadonlyArray<{ id: string; provider: string }>
): readonly string[] | undefined {
    const explicit = filter.accounts?.length ? [...filter.accounts] : undefined;

    if (!filter.providers?.length) {
        return explicit;
    }

    const wanted = new Set(filter.providers.map(resolveProviderFilter));
    const ids = enabled.filter((account) => wanted.has(account.provider)).map((account) => account.id);

    // Claude transcripts carry no account marker, so a whole provider's spend
    // arrives under one pseudo account that belongs to anthropic.
    if (wanted.has("anthropic-sub")) {
        ids.push(CLAUDE_ALL_ACCOUNT_ID);
    }

    if (!explicit) {
        return ids;
    }

    const allowed = new Set(explicit);
    return ids.filter((id) => allowed.has(id));
}
