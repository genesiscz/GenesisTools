import { type RefObject, useEffect } from "react";
import type { LogSearchState } from "@/components/LogSearchPopover";

export function scrollToFirstLogMatch(container: HTMLElement | null): void {
    if (!container) {
        return;
    }

    const first = container.querySelector('[data-log-match="true"]');

    if (first) {
        first.scrollIntoView({ block: "center", behavior: "smooth" });
    }
}

export function useScrollToFirstLogMatch(
    scrollRef: RefObject<HTMLElement | null>,
    logSearch: LogSearchState,
    matchCount: number,
    isSearchActive: boolean
): void {
    useEffect(() => {
        if (!isSearchActive || matchCount === 0) {
            return;
        }

        scrollToFirstLogMatch(scrollRef.current);
    }, [scrollRef, logSearch.query, logSearch.contextLines, matchCount, isSearchActive]);
}
