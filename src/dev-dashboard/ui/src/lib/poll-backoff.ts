interface PolledQuery {
    state: { data: unknown; dataUpdateCount: number };
}

interface Streak {
    data: unknown;
    dataUpdateCount: number;
    unchanged: number;
}

const streaks = new WeakMap<PolledQuery, Streak>();

/**
 * A React Query `refetchInterval` that doubles, from `baseMs` up to `maxMs`, for every poll
 * whose answer equals the one before it, and drops back to `baseMs` on the first change.
 *
 * Structural sharing keeps the previous data object when a refetch returns equal JSON, while
 * `dataUpdateCount` still counts the fetch, so "count moved, data did not" is an unchanged
 * poll. The streak lives on the query, so every observer of it computes the same interval.
 * An invalidation after a user action still refetches at once.
 */
export function backoffRefetchInterval(baseMs: number, maxMs: number): (query: PolledQuery) => number {
    return (query) => {
        const { data, dataUpdateCount } = query.state;
        const streak = streaks.get(query);

        if (!streak) {
            streaks.set(query, { data, dataUpdateCount, unchanged: 0 });
            return baseMs;
        }

        if (dataUpdateCount !== streak.dataUpdateCount) {
            streak.unchanged = data === streak.data ? streak.unchanged + 1 : 0;
            streak.data = data;
            streak.dataUpdateCount = dataUpdateCount;
        }

        return Math.min(maxMs, baseMs * 2 ** streak.unchanged);
    };
}
