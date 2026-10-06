import { SafeJSON } from "@dashboard/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { applyCommittedTimerEvent, recoverTimerQueries, type TimerSSECacheEvent } from "../timer-sse-cache";

/**
 * Subscribe to server-sent timer events.
 * Updates TanStack Query cache in real-time when the server emits changes.
 * Reconnects automatically on connection loss (browser EventSource behaviour).
 *
 * Only mounts when userId is provided (no-auth dev fallback passes "dev-user").
 */
export function useTimerSSE(userId: string | null) {
    const qc = useQueryClient();

    useEffect(() => {
        if (!userId) {
            return;
        }

        if (typeof EventSource === "undefined") {
            return; // SSR guard
        }

        const es = new EventSource(`/api/timer-events?userId=${encodeURIComponent(userId)}`);

        es.onopen = () => {
            recoverTimerQueries(qc, userId);
        };

        es.onmessage = (msg) => {
            try {
                const event = SafeJSON.parse<TimerSSECacheEvent>(msg.data);
                applyCommittedTimerEvent(qc, userId, event);
            } catch {
                // malformed event — ignore
            }
        };

        es.onerror = () => {
            // EventSource auto-reconnects — nothing to do here
        };

        return () => {
            es.close();
        };
    }, [userId, qc]);
}
