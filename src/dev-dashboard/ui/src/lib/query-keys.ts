import type { QueryClient } from "@tanstack/react-query";

/**
 * Refresh the tmux-session list and the ttyd-session list together.
 *
 * A tmux mutation (rename/kill/attach/detach) changes ttyd attachment state and
 * vice versa, so the two lists must always be invalidated as a pair — invalidating
 * only one leaves the UI showing stale attachment badges.
 */
export function invalidateTmuxAndTtyd(queryClient: QueryClient): void {
    queryClient.invalidateQueries({ queryKey: ["tmux"] });
    queryClient.invalidateQueries({ queryKey: ["ttyd"] });
}
