/**
 * useTimerStore — TanStack Query wrapper for the timer list.
 *
 * Replaces the old in-memory TanStack Store that was never seeded from the server
 * (causing the "Loading timers..." forever bug). This hook fetches from SQLite via
 * server functions and caches with TanStack Query.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Timer } from "@/drizzle";
import { broadcastInvalidate, CHRONO_SYNC_CHANNEL } from "@/lib/sync/useBroadcastInvalidation";
import { createTimerOnServer, deleteTimerFromServer, getTimersFromServer } from "@/lib/timer/timer-sync.server";

/** Dev fallback userId when no WorkOS session is present. */
const DEV_USER_ID = "dev-user";

export function useTimerStore(userId: string | null) {
    const effectiveUserId = userId ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const qc = useQueryClient();

    const query = useQuery({
        queryKey: ["timers", effectiveUserId],
        queryFn: () => getTimersFromServer(),
        enabled: !!effectiveUserId,
        staleTime: 10_000,
        refetchOnWindowFocus: true,
    });

    const createMutation = useMutation({
        mutationFn: (input: { name: string; timerType: "stopwatch" | "countdown" | "pomodoro"; duration?: number }) =>
            createTimerOnServer({
                data: {
                    name: input.name,
                    timerType: input.timerType,
                    duration: input.duration,
                },
            }),
        onSuccess: (newTimer) => {
            qc.setQueryData(["timers", effectiveUserId], (old: Timer[] | undefined) => [newTimer, ...(old ?? [])]);
            broadcastInvalidate(CHRONO_SYNC_CHANNEL, ["timers", effectiveUserId]);
        },
    });

    const deleteMutation = useMutation({
        mutationFn: (timerId: string) => deleteTimerFromServer({ data: { timerId } }),
        onSuccess: (_, timerId) => {
            qc.setQueryData(["timers", effectiveUserId], (old: Timer[] | undefined) =>
                (old ?? []).filter((t) => t.id !== timerId)
            );
            broadcastInvalidate(CHRONO_SYNC_CHANNEL, ["timers", effectiveUserId]);
        },
    });

    async function createTimer(input: {
        name: string;
        timerType: "stopwatch" | "countdown" | "pomodoro";
        duration?: number;
    }): Promise<Timer | null> {
        if (!effectiveUserId) {
            return null;
        }

        return createMutation.mutateAsync(input);
    }

    async function deleteTimer(timerId: string): Promise<boolean> {
        if (!effectiveUserId) {
            return false;
        }

        const result = await deleteMutation.mutateAsync(timerId);
        return result.success;
    }

    function getTimer(id: string): Timer | undefined {
        return (query.data ?? []).find((t) => t.id === id);
    }

    return {
        timers: query.data ?? [],
        loading: query.isLoading,
        error: query.error ? String(query.error) : null,
        initialized: query.isFetched,
        createTimer,
        deleteTimer,
        getTimer,
    };
}
