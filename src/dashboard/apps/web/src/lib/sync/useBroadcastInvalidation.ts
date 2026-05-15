/**
 * BroadcastChannel-based cross-tab query invalidation.
 *
 * Usage:
 *   // In feature root component:
 *   useBroadcastInvalidation(ASSISTANT_SYNC_CHANNEL);
 *
 *   // After a mutation:
 *   broadcastInvalidate(ASSISTANT_SYNC_CHANNEL, ["assistant-tasks"]);
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export const CHRONO_SYNC_CHANNEL = "chrono_sync_channel";
export const ASSISTANT_SYNC_CHANNEL = "assistant_sync_channel";

interface BroadcastInvalidateMessage {
    type: "invalidate";
    queryKey: unknown[];
}

/**
 * Broadcast a query invalidation to other tabs on the same channel.
 * Also invalidates locally so the current tab stays in sync.
 */
export function broadcastInvalidate(channelName: string, queryKey: unknown[]): void {
    try {
        const channel = new BroadcastChannel(channelName);
        const message: BroadcastInvalidateMessage = { type: "invalidate", queryKey };
        channel.postMessage(message);
        channel.close();
    } catch {
        // BroadcastChannel not supported (e.g. SSR) — silently skip
    }
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
