import type { IndexedLogEntry } from "@app/debugging-master/types";
import { fuzzySearchWithContext } from "@app/utils/fuzzy-search";
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
    isSearchActive: boolean;
}

export function useLogSearchDisplay<T extends LogSearchableLine>(items: readonly T[]): UseLogSearchDisplayResult<T> {
    const [logSearch, setLogSearch] = useState<LogSearchState>(DEFAULT_LOG_SEARCH);

    const result = useMemo(() => {
        return fuzzySearchWithContext({
            items,
            query: logSearch.query,
            haystack: (item) => logLineHaystack(item),
            contextLines: logSearch.contextLines,
        });
    }, [items, logSearch.query, logSearch.contextLines]);

    const hits = useMemo((): LogLineHit<T>[] => {
        const hasTokens = result.tokens.length > 0;

        return result.hits.map((hit) => ({
            item: hit.item,
            isMatch: hit.isMatch,
            isContext: !hit.isMatch && hasTokens,
        }));
    }, [result]);

    const hitByIndex = useMemo(() => {
        const map = new Map<number, { isMatch: boolean; isContext: boolean }>();

        for (const hit of hits) {
            map.set(hit.item.index, { isMatch: hit.isMatch, isContext: hit.isContext });
        }

        return map;
    }, [hits]);

    return {
        logSearch,
        setLogSearch,
        highlightTokens: result.tokens,
        matchCount: result.matchCount,
        lineCount: hits.length,
        hits,
        hitByIndex,
        isSearchActive: result.tokens.length > 0,
    };
}

export function resetLogSearchState(): LogSearchState {
    return { ...DEFAULT_LOG_SEARCH };
}
