import { useCallback, useMemo } from "react";
import { type AiAccountsFilters, DEFAULT_FILTERS, parseFilters, type TimeRange } from "@/lib/ai-accounts-filters";
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

    const toggleProvider = useCallback(
        (providerId: string) => setFilters((prev) => ({ ...prev, providers: toggle(prev.providers, providerId) })),
        [setFilters]
    );
    const toggleAccount = useCallback(
        (accountId: string) => setFilters((prev) => ({ ...prev, accountIds: toggle(prev.accountIds, accountId) })),
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
