import { useCallback, useMemo } from "react";
import {
    type AiAccountsFilters,
    DEFAULT_FILTERS,
    parseFilters,
    type TimeRange,
    toggleFilterId,
} from "@/lib/ai-accounts-filters";
import { parseStringArray, usePersistedState } from "@/lib/persisted-state";

export const FILTERS_KEY = "dd:ai-accounts:filters";
export const SPEND_HIDDEN_KEY = "dd:ai-accounts:spend:hidden";

function toggle(list: readonly string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Page-level filters: providers, accounts, time range. Persisted per browser. */
export function useAiAccountsFilters() {
    const [filters, setFilters, reset] = usePersistedState<AiAccountsFilters>(
        FILTERS_KEY,
        parseFilters,
        DEFAULT_FILTERS
    );

    // `allIds` is what the chip row rendered. An empty filter means "everything",
    // so the first click has to seed the list from those ids and remove the one
    // that was clicked, rather than select it alone.
    const toggleProvider = useCallback(
        (providerId: string, allIds: readonly string[]) =>
            setFilters((prev) => ({ ...prev, providers: toggleFilterId(prev.providers, providerId, allIds) })),
        [setFilters]
    );
    const toggleAccount = useCallback(
        (accountId: string, allIds: readonly string[]) =>
            setFilters((prev) => ({ ...prev, accountIds: toggleFilterId(prev.accountIds, accountId, allIds) })),
        [setFilters]
    );
    const setAccounts = useCallback(
        (accountIds: string[]) => setFilters((prev) => ({ ...prev, accountIds })),
        [setFilters]
    );
    const setRange = useCallback((range: TimeRange) => setFilters((prev) => ({ ...prev, range })), [setFilters]);

    return useMemo(
        () => ({ filters, toggleProvider, toggleAccount, setAccounts, setRange, reset }),
        [filters, toggleProvider, toggleAccount, setAccounts, setRange, reset]
    );
}

const EMPTY: string[] = [];

/** Accounts hidden inside the spend widget only. Separate from the page filter so a glance can drop one line. */
export function useSpendHiddenAccounts() {
    const [hidden, setHidden] = usePersistedState<string[]>(SPEND_HIDDEN_KEY, parseStringArray, EMPTY);
    const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
    const toggleHidden = useCallback((accountId: string) => setHidden((prev) => toggle(prev, accountId)), [setHidden]);
    const showAll = useCallback(() => setHidden([]), [setHidden]);

    return { hiddenSet, toggleHidden, showAll };
}
