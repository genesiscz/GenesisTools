export const BACKLOG_LIMIT = 500;

export function appendLiveWithCap<T>(prev: T[], entry: T, limit = BACKLOG_LIMIT): { next: T[]; evictedCount: number } {
    const next = [...prev, entry];

    if (next.length <= limit) {
        return { next, evictedCount: 0 };
    }

    const evictedCount = next.length - limit;
    next.splice(0, evictedCount);
    return { next, evictedCount };
}

/** Trim row refs for live rows evicted from the front of the merged list. */
export function trimRowRefsForEvictedLive(
    rowRefs: Map<number, unknown>,
    backlogLen: number,
    evictedCount: number
): void {
    for (let i = 0; i < evictedCount; i++) {
        rowRefs.delete(backlogLen + i);
    }
}