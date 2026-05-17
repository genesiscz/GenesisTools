import { SafeJSON } from "@dashboard/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Timer } from "@/drizzle";

interface TimerSSEEvent {
    type: string;
    timerId?: string;
    snapshot?: Timer;
    payload?: unknown;
}

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

        es.onmessage = (msg) => {
            try {
                const event = SafeJSON.parse<TimerSSEEvent>(msg.data);

                if (event.type === "timer_changed" && event.snapshot) {
                    // Patch the specific timer in the list cache
                    qc.setQueryData(["timers", userId], (old: Timer[] | undefined) => {
                        if (!Array.isArray(old)) {
                            return old;
                        }

                        return old.map((t) => (t.id === event.snapshot?.id ? event.snapshot : t));
                    });
                } else {
                    // For other events (phase_changed, countdown_complete, etc.)
                    // just invalidate so the next render re-fetches
                    qc.invalidateQueries({ queryKey: ["timers", userId] });
                }

                // Every action-based mutation persists an activity-log row and
                // emits an SSE event — keep the activity log live in lockstep.
                qc.invalidateQueries({ queryKey: ["activity-logs", userId] });
                qc.invalidateQueries({ queryKey: ["focus-stats-today", userId] });
                qc.invalidateQueries({ queryKey: ["focus-sessions-today", userId] });
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
