import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Timer } from "@/drizzle";
import { broadcastInvalidate, CHRONO_SYNC_CHANNEL } from "@/lib/sync/useBroadcastInvalidation";
import {
    advancePomodoroPhase,
    lapTimer,
    pauseTimer,
    resetTimer,
    startTimer,
    updateTimerMetadata,
} from "@/lib/timer/timer-sync.server";
import { formatTime, formatTimeCompact, useTimerEngine } from "./useTimerEngine";
import { useTimerStore } from "./useTimerStore";

/** Dev fallback userId when no WorkOS session is present. */
const DEV_USER_ID = "dev-user";

interface UseTimerOptions {
    userId: string | null;
    timerId: string;
}

interface UseTimerReturn {
    timer: Timer | undefined;
    displayTime: number;
    formattedTime: string;
    formattedTimeCompact: string;
    isRunning: boolean;
    // Actions
    start: () => void;
    pause: () => void;
    reset: () => void;
    toggleRunning: () => void;
    addLap: () => void;
    clearLaps: () => void;
    setName: (name: string) => void;
    setDuration: (durationMs: number) => void;
    setType: (type: "stopwatch" | "countdown" | "pomodoro") => void;
    editElapsedTime: (newElapsedMs: number) => void;
    toggleShowTotal: () => void;
    // Computed
    totalTimeElapsed: number;
    completionPercentage: number;
}

/**
 * Hook for controlling an individual timer.
 * All mutations go to the server via action-based server functions.
 * Client never computes elapsed — server handles state transitions.
 */
export function useTimer({ userId, timerId }: UseTimerOptions): UseTimerReturn {
    const effectiveUserId = userId ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const qc = useQueryClient();
    const { getTimer } = useTimerStore(userId);
    const timer = getTimer(timerId);

    function onSuccess(updated: Timer) {
        qc.setQueryData(["timers", effectiveUserId], (old: Timer[] | undefined) =>
            (old ?? []).map((t) => (t.id === updated.id ? updated : t))
        );
        broadcastInvalidate(CHRONO_SYNC_CHANNEL, ["timers", effectiveUserId]);
    }

    function onConflict() {
        qc.invalidateQueries({ queryKey: ["timers", effectiveUserId] });
    }

    const startMutation = useMutation({
        mutationFn: () =>
            startTimer({
                data: { id: timerId, userId: effectiveUserId!, expectedVersion: timer?.version },
            }),
        onSuccess,
        onError: (err) => {
            if (String(err).includes("changed in another tab")) {
                onConflict();
            }
        },
    });

    const pauseMutation = useMutation({
        mutationFn: () =>
            pauseTimer({
                data: { id: timerId, userId: effectiveUserId!, expectedVersion: timer?.version },
            }),
        onSuccess,
        onError: (err) => {
            if (String(err).includes("changed in another tab")) {
                onConflict();
            }
        },
    });

    const resetMutation = useMutation({
        mutationFn: () =>
            resetTimer({
                data: { id: timerId, userId: effectiveUserId!, expectedVersion: timer?.version },
            }),
        onSuccess,
        onError: (err) => {
            if (String(err).includes("changed in another tab")) {
                onConflict();
            }
        },
    });

    const lapMutation = useMutation({
        mutationFn: () =>
            lapTimer({
                data: { id: timerId, userId: effectiveUserId!, expectedVersion: timer?.version },
            }),
        onSuccess,
    });

    const advanceMutation = useMutation({
        mutationFn: () =>
            advancePomodoroPhase({
                data: { id: timerId, userId: effectiveUserId!, expectedVersion: timer?.version },
            }),
        onSuccess,
    });

    const metadataMutation = useMutation({
        mutationFn: (patch: Partial<Pick<Timer, "name" | "showTotal" | "duration" | "elapsedTime" | "timerType">>) =>
            updateTimerMetadata({
                data: {
                    id: timerId,
                    userId: effectiveUserId!,
                    expectedVersion: timer?.version,
                    patch,
                },
            }),
        onSuccess,
    });

    const { displayTime, isRunning } = useTimerEngine(timer ?? null, {
        onTargetReached: () => {
            if (!timer) {
                return;
            }

            if (timer.timerType === "pomodoro") {
                advanceMutation.mutate();
            } else if (timer.timerType === "countdown") {
                pauseMutation.mutate();
            }
        },
    });

    function start() {
        if (!effectiveUserId || !timer) {
            return;
        }

        startMutation.mutate();
    }

    function pause() {
        if (!effectiveUserId || !timer || !timer.isRunning) {
            return;
        }

        pauseMutation.mutate();
    }

    function toggleRunning() {
        if (timer?.isRunning) {
            pause();
        } else {
            start();
        }
    }

    function reset() {
        if (!effectiveUserId || !timer) {
            return;
        }

        resetMutation.mutate();
    }

    function addLap() {
        if (!effectiveUserId || !timer || !timer.isRunning) {
            return;
        }

        lapMutation.mutate();
    }

    function clearLaps() {
        if (!effectiveUserId || !timer) {
            return;
        }

        // Laps are cleared only on full reset (state machine design).
        resetMutation.mutate();
    }

    function setName(name: string) {
        metadataMutation.mutate({ name });
    }

    function setDuration(durationMs: number) {
        if (timer?.isRunning) {
            return;
        }

        metadataMutation.mutate({ duration: durationMs });
    }

    function setType(type: "stopwatch" | "countdown" | "pomodoro") {
        if (timer?.isRunning) {
            return;
        }

        metadataMutation.mutate({ timerType: type, elapsedTime: 0 });
    }

    function editElapsedTime(newElapsedMs: number) {
        if (!timer || timer.isRunning) {
            return;
        }

        metadataMutation.mutate({ elapsedTime: newElapsedMs });
    }

    function toggleShowTotal() {
        if (!timer) {
            return;
        }

        metadataMutation.mutate({ showTotal: timer.showTotal ? 0 : 1 });
    }

    function calcTotalTimeElapsed(): number {
        if (!timer?.firstStartTime) {
            return 0;
        }

        return Date.now() - new Date(timer.firstStartTime).getTime();
    }

    function calcCompletionPercentage(): number {
        if (!timer || timer.timerType === "stopwatch") {
            return 0;
        }

        if (!timer.duration) {
            return 0;
        }

        return Math.min(100, (timer.elapsedTime / timer.duration) * 100);
    }

    return {
        timer,
        displayTime,
        formattedTime: formatTime(displayTime),
        formattedTimeCompact: formatTimeCompact(displayTime),
        isRunning,
        start,
        pause,
        reset,
        toggleRunning,
        addLap,
        clearLaps,
        setName,
        setDuration,
        setType,
        editElapsedTime,
        toggleShowTotal,
        totalTimeElapsed: calcTotalTimeElapsed(),
        completionPercentage: calcCompletionPercentage(),
    };
}
