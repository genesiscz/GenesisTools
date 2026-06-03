import type { IndexedLogEntry } from "@app/debugging-master/types";
import { fuzzySearchWithContext } from "@app/utils/fuzzy-search";
import { tokenizeSearch } from "@app/utils/fuzzy-tokens";
import { useMemo, useState } from "react";
import { DEFAULT_LOG_SEARCH, type LogSearchState } from "@/components/LogSearchPopover";
import { logLineHaystack } from "./log-line-haystack";

export type LogSearchableLine = Pick<IndexedLogEntry, "index" | "level" | "label" | "msg" | "msgAnsi" | "h" | "file">;

export interface LogLineHit<T extends LogSearchableLine> {
    item: T;
    isMatch: boolean;
    isContext: boolean;
}

export interface UseLogSearchDisplayResult<T extends LogSearchableLine> {
    logSearch: LogSearchState;
    setLogSearch: (next: LogSearchState) => void;
    highlightTokens: string[];
    matchCount: number;
    lineCount: number;
    hits: LogLineHit<T>[];
    hitByIndex: Map<number, { isMatch: boolean; isContext: boolean }>;
    /** Query has tokens (search engaged). */
    isSearchActive: boolean;
    /** Fuzzy filter is narrowing the visible lines (not frozen). */
    isFilterActive: boolean;
}

export function useLogSearchDisplay<T extends LogSearchableLine>(items: readonly T[]): UseLogSearchDisplayResult<T> {
    const [logSearch, setLogSearch] = useState<LogSearchState>(DEFAULT_LOG_SEARCH);

    const filtered = useMemo(() => {
        return fuzzySearchWithContext({
            items,
            query: logSearch.query,
            haystack: (item) => logLineHaystack(item),
            contextLines: logSearch.contextLines,
        });
    }, [items, logSearch.query, logSearch.contextLines]);

    const frozenWithQuery = Boolean(logSearch.frozen && logSearch.query.trim().length > 0);
    const highlightTokens = frozenWithQuery ? tokenizeSearch(logSearch.query) : filtered.tokens;

    const hits = useMemo((): LogLineHit<T>[] => {
        if (frozenWithQuery) {
            return items.map((item) => ({
                item,
                isMatch: false,
                isContext: false,
            }));
        }

        const hasTokens = filtered.tokens.length > 0;

        return filtered.hits.map((hit) => ({
            item: hit.item,
            isMatch: hit.isMatch,
            isContext: !hit.isMatch && hasTokens,
        }));
    }, [filtered.hits, filtered.tokens, frozenWithQuery, items]);

    const hitByIndex = useMemo(() => {
        const map = new Map<number, { isMatch: boolean; isContext: boolean }>();

        for (const hit of hits) {
            map.set(hit.item.index, { isMatch: hit.isMatch, isContext: hit.isContext });
        }

        return map;
    }, [hits]);

    const isSearchActive = highlightTokens.length > 0;
    const isFilterActive = isSearchActive && !frozenWithQuery;

    return {
        logSearch,
        setLogSearch,
        highlightTokens,
        matchCount: filtered.matchCount,
        lineCount: hits.length,
        hits,
        hitByIndex,
        isSearchActive,
        isFilterActive,
    };
}

export function resetLogSearchState(): LogSearchState {
    return { ...DEFAULT_LOG_SEARCH };
}
