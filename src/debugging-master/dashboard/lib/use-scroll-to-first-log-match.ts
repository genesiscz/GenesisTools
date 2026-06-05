import { type RefObject, useEffect } from "react";
import type { LogSearchState } from "@/components/LogSearchPopover";

/** Search inputs that should trigger a one-time jump to the first match (not live tail updates). */
export function logMatchScrollEffectKey(logSearch: LogSearchState): string {
    return `${logSearch.query}\0${logSearch.contextLines}`;
}

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
    const searchKey = logMatchScrollEffectKey(logSearch);

    useEffect(() => {
        if (!isSearchActive || matchCount === 0) {
            return;
        }

        scrollToFirstLogMatch(scrollRef.current);
        // matchCount intentionally omitted: new live lines must not re-scroll to the first match.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scrollRef, searchKey, isSearchActive]);
}
