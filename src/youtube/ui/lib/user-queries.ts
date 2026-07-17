import type { QueryClient } from "@tanstack/react-query";

/** Query keys whose data belongs to the signed-in user. Dropped on logout so
 *  gated UI reverts immediately — invalidating alone keeps the last value on
 *  screen while the refetch 401s. */
export const USER_SCOPED_QUERY_KEYS = [
    "me",
    "userSettings",
    "collections",
    "collection",
    "threads",
    "thread",
    "history",
    "watchlist",
    "digest",
] as const;

export function clearUserScopedQueries(queryClient: QueryClient) {
    for (const key of USER_SCOPED_QUERY_KEYS) {
        queryClient.removeQueries({ queryKey: [key] });
    }
}
