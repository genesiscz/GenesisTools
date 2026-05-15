/**
 * BroadcastChannel-based cross-tab query invalidation.
 *
 * Usage:
 *   // In feature root component (subscribes this tab to invalidations from others):
 *   useBroadcastInvalidation(ASSISTANT_SYNC_CHANNEL);
 *
 *   // In mutation onSuccess (invalidates locally AND notifies other tabs):
 *   const invalidate = useInvalidateAndBroadcast(ASSISTANT_SYNC_CHANNEL);
 *   invalidate(["assistant-tasks"]);
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

export const CHRONO_SYNC_CHANNEL = "chrono_sync_channel";
export const ASSISTANT_SYNC_CHANNEL = "assistant_sync_channel";

interface BroadcastInvalidateMessage {
    type: "invalidate";
    queryKey: unknown[];
}

/**
 * Broadcast a query invalidation to OTHER tabs on the same channel.
 * Does NOT invalidate locally — call queryClient.invalidateQueries separately,
 * or use useInvalidateAndBroadcast() which does both.
 */
export function broadcastInvalidate(channelName: string, queryKey: readonly unknown[]): void {
    try {
        const channel = new BroadcastChannel(channelName);
        const message: BroadcastInvalidateMessage = { type: "invalidate", queryKey: Array.from(queryKey) };
        channel.postMessage(message);
        channel.close();
    } catch {
        // BroadcastChannel not supported (e.g. SSR) — silently skip
    }
}

/**
 * Returns a stable callback that invalidates locally AND broadcasts to other tabs.
 * Use this in mutation onSuccess handlers instead of calling both functions manually.
 */
export function useInvalidateAndBroadcast(channelName: string) {
    const queryClient = useQueryClient();

    return useCallback(
        (queryKey: readonly unknown[]) => {
            queryClient.invalidateQueries({ queryKey: Array.from(queryKey) });
            broadcastInvalidate(channelName, queryKey);
        },
        [channelName, queryClient]
    );
}

/**
 * Subscribe to invalidation messages from other tabs and forward them
 * to the local TanStack Query client. Mount this once per feature root.
 */
export function useBroadcastInvalidation(channelName: string): void {
    const queryClient = useQueryClient();

    useEffect(() => {
        let channel: BroadcastChannel | null = null;

        try {
            channel = new BroadcastChannel(channelName);

            channel.onmessage = (event: MessageEvent<BroadcastInvalidateMessage>) => {
                if (event.data?.type === "invalidate" && Array.isArray(event.data.queryKey)) {
                    queryClient.invalidateQueries({ queryKey: event.data.queryKey });
                }
            };
        } catch {
            // BroadcastChannel not supported — silently skip
        }

        return () => {
            channel?.close();
        };
    }, [channelName, queryClient]);
}
