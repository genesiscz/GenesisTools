import type { LapEntry, Timer, TimerInput, TimerUpdate } from "@dashboard/shared";
import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";

/**
 * Timer store state
 */
interface TimerStoreState {
    timers: Timer[];
    loading: boolean;
    error: string | null;
    initialized: boolean;
}

/**
 * Create the timer store
 */
export const timerStore = new Store<TimerStoreState>({
    timers: [],
    loading: false,
    error: null,
    initialized: false,
});

/**
 * Hook to use the timer store with in-memory state management.
 * Timer persistence is handled by the server via TanStack Query / server functions.
 */
export function useTimerStore(userId: string | null) {
    const state = useStore(timerStore);

    // Create timer (in-memory only — caller is responsible for server persistence)
    function createTimer(input: TimerInput): Timer | null {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const timer: Timer = {
            id: crypto.randomUUID(),
            userId,
            name: input.name ?? "Timer",
            timerType: input.timerType ?? "stopwatch",
            isRunning: false,
            elapsedTime: 0,
            duration: input.duration,
            laps: [],
            startTime: null,
            firstStartTime: null,
            showTotal: false,
            pomodoroSessionCount: 0,
            createdAt: now,
            updatedAt: now,
        };

        timerStore.setState((s) => ({
            ...s,
            timers: [...s.timers, timer],
            initialized: true,
        }));

        return timer;
    }

    // Update timer with optimistic update
    function updateTimer(id: string, updates: TimerUpdate): Timer | null {
        let updatedTimer: Timer | null = null;

        timerStore.setState((s) => {
            const timers = s.timers.map((t) => {
                if (t.id !== id) {
                    return t;
                }
                const updated = { ...t, ...updates, updatedAt: new Date() };
                updatedTimer = updated;
                return updated;
            });
            return { ...s, timers };
        });

        return updatedTimer;
    }

    // Delete timer
    function deleteTimer(id: string): boolean {
        timerStore.setState((s) => ({
            ...s,
            timers: s.timers.filter((t) => t.id !== id),
        }));
        return true;
    }

    // Get single timer from state
    function getTimer(id: string): Timer | undefined {
        return state.timers.find((t) => t.id === id);
    }

    // Add lap to timer
    function addLap(timerId: string, elapsedMs: number): LapEntry | null {
        const timer = state.timers.find((t) => t.id === timerId);
        if (!timer) {
            return null;
        }

        const lapNumber = (timer.laps?.length ?? 0) + 1;
        const previousLap = timer.laps?.[timer.laps.length - 1];
        const lapTime = previousLap ? elapsedMs - previousLap.splitTime : elapsedMs;

        const newLap: LapEntry = {
            number: lapNumber,
            lapTime,
            splitTime: elapsedMs,
            timestamp: new Date(),
        };

        const updatedLaps = [...(timer.laps ?? []), newLap];
        updateTimer(timerId, { laps: updatedLaps });
        return newLap;
    }

    // Clear laps
    function clearLaps(timerId: string): void {
        updateTimer(timerId, { laps: [] });
    }

    // Load timers into store (called by parent with server data)
    function loadTimers(serverTimers: Timer[]): void {
        timerStore.setState((s) => ({
            ...s,
            timers: serverTimers,
            initialized: true,
            loading: false,
        }));
    }

    // Clear error
    function clearError() {
        timerStore.setState((s) => ({ ...s, error: null }));
    }

    return {
        timers: state.timers,
        loading: state.loading,
        error: state.error,
        initialized: state.initialized,
        createTimer,
        updateTimer,
        deleteTimer,
        getTimer,
        addLap,
        clearLaps,
        loadTimers,
        clearError,
    };
}
