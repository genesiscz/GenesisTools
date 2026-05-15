import type { PomodoroPhase, PomodoroSettings } from "@dashboard/shared";
import { DEFAULT_POMODORO_SETTINGS } from "@dashboard/shared";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useEffect, useRef, useState } from "react";
import { CHRONO_SYNC_CHANNEL, useBroadcastInvalidation } from "@/lib/sync/useBroadcastInvalidation";
import { computeLiveElapsed, computePomodoroTarget } from "@/lib/timer/timer-state-machine";
import { useTimer } from "@/lib/timer/hooks/useTimer";
import { useTimerSSE } from "@/lib/timer/hooks/useTimerSSE";
import { useTimerStore } from "@/lib/timer/hooks/useTimerStore";

/** Dev fallback userId when no WorkOS session is present. */
const DEV_USER_ID = "dev-user";

/** The single canonical pomodoro timer for Focus Mode. Created once, reused. */
const FOCUS_TIMER_NAME = "Focus";

export interface PendingTransition {
    fromPhase: PomodoroPhase;
    toPhase: PomodoroPhase;
    sessionCount: number;
}

export function useFocusSession() {
    const { user } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);

    // 3-channel sync: SSE + BroadcastChannel + refetchOnWindowFocus
    useTimerSSE(userId);
    useBroadcastInvalidation(CHRONO_SYNC_CHANNEL);

    const { timers, loading, error, createTimer } = useTimerStore(userId);

    const focusTimer = timers.find((t) => t.name === FOCUS_TIMER_NAME && t.timerType === "pomodoro") ?? null;

    const [isCreating, setIsCreating] = useState(false);
    const [pendingTransition, setPendingTransition] = useState<PendingTransition | null>(null);
    const prevPhaseRef = useRef<PomodoroPhase | null>(null);

    // Detect phase transition by comparing server-confirmed phase across renders
    const currentPhase: PomodoroPhase = (focusTimer?.pomodoroPhase as PomodoroPhase | null | undefined) ?? "work";

    useEffect(() => {
        const prev = prevPhaseRef.current;

        if (prev !== null && prev !== currentPhase && prev === "work") {
            // work → break transition: fire celebration
            setPendingTransition({
                fromPhase: prev,
                toPhase: currentPhase,
                sessionCount: focusTimer?.pomodoroSessionCount ?? 0,
            });
        }

        prevPhaseRef.current = currentPhase;
    }, [currentPhase, focusTimer?.pomodoroSessionCount]);

    // Per-timer hook — safe to call even with empty string (guard prevents mutations)
    const timerActions = useTimer({ userId, timerId: focusTimer?.id ?? "" });

    const settings: PomodoroSettings =
        (focusTimer?.pomodoroSettings as PomodoroSettings | null | undefined) ?? DEFAULT_POMODORO_SETTINGS;
    const target = computePomodoroTarget(focusTimer ?? { timerType: "pomodoro", pomodoroPhase: "work", pomodoroSettings: null } as Parameters<typeof computePomodoroTarget>[0]);

    // Live elapsed: use engine's displayTime when we have a timer; fall back to 0
    const elapsedMs = focusTimer ? computeLiveElapsed(focusTimer, Date.now()) : 0;
    // For display we want remaining time for pomodoro
    const remainingMs = Math.max(0, (target ?? 0) - elapsedMs);
    const progressRatio = (target ?? 0) > 0 ? Math.min(1, elapsedMs / (target ?? 1)) : 0;

    async function ensureFocusTimer() {
        if (focusTimer || isCreating || !userId) {
            return;
        }

        setIsCreating(true);

        try {
            await createTimer({ name: FOCUS_TIMER_NAME, timerType: "pomodoro" });
        } finally {
            setIsCreating(false);
        }
    }

    function updateSettings(patch: Partial<PomodoroSettings>) {
        if (!focusTimer) {
            return;
        }

        timerActions.setPomodoroSettings({ ...settings, ...patch });
    }

    function dismissTransition() {
        setPendingTransition(null);
    }

    return {
        isLoading: loading,
        error,
        focusTimer,
        phase: currentPhase,
        sessionCount: focusTimer?.pomodoroSessionCount ?? 0,
        settings,
        elapsedMs,
        remainingMs,
        target: target ?? 0,
        progressRatio,
        isRunning: Boolean(focusTimer?.isRunning),
        // Actions (delegated to useTimer which guards focusTimer existence)
        start: timerActions.start,
        pause: timerActions.pause,
        reset: timerActions.reset,
        skipPhase: timerActions.advancePhase,
        updateSettings,
        ensureFocusTimer,
        isCreating,
        pendingTransition,
        dismissTransition,
    };
}
