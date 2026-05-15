import type { Timer, TimerType } from "@dashboard/shared";
import { formatTime, formatTimeCompact, useTimerEngine } from "./useTimerEngine";
import { useTimerStore } from "./useTimerStore";

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
    setType: (type: TimerType) => void;
    editElapsedTime: (newElapsedMs: number) => void;
    toggleShowTotal: () => void;
    // Computed
    totalTimeElapsed: number;
    completionPercentage: number;
}

/**
 * Hook for controlling an individual timer
 */
export function useTimer({ userId, timerId }: UseTimerOptions): UseTimerReturn {
    const { getTimer, updateTimer, addLap: addLapToStore, clearLaps: clearLapsFromStore } = useTimerStore(userId);

    const timer = getTimer(timerId);
    const { displayTime, isRunning } = useTimerEngine(timer);

    // Start timer
    function start() {
        if (!timer) {
            return;
        }

        const now = new Date();
        const updates: Partial<Timer> = {
            isRunning: true,
            startTime: now,
        };

        if (!timer.firstStartTime) {
            updates.firstStartTime = now;
        }

        updateTimer(timerId, updates);
    }

    // Pause timer
    function pause() {
        if (!timer || !timer.isRunning || !timer.startTime) {
            return;
        }

        const startTime =
            timer.startTime instanceof Date ? timer.startTime.getTime() : new Date(timer.startTime).getTime();
        const sessionDuration = Date.now() - startTime;
        const newElapsed = (timer.elapsedTime ?? 0) + sessionDuration;

        updateTimer(timerId, {
            isRunning: false,
            startTime: null,
            elapsedTime: newElapsed,
        });
    }

    // Toggle running state
    function toggleRunning() {
        if (timer?.isRunning) {
            pause();
        } else {
            start();
        }
    }

    // Reset timer
    function reset() {
        if (!timer) {
            return;
        }

        updateTimer(timerId, {
            isRunning: false,
            startTime: null,
            elapsedTime: 0,
            laps: [],
            pomodoroSessionCount: 0,
        });
    }

    // Add lap
    function addLap() {
        if (!timer) {
            return;
        }

        let currentElapsed = timer.elapsedTime ?? 0;
        if (timer.isRunning && timer.startTime) {
            const startTime =
                timer.startTime instanceof Date ? timer.startTime.getTime() : new Date(timer.startTime).getTime();
            currentElapsed += Date.now() - startTime;
        }

        addLapToStore(timerId, currentElapsed);
    }

    // Clear laps
    function clearLaps() {
        clearLapsFromStore(timerId);
    }

    // Set timer name
    function setName(name: string) {
        updateTimer(timerId, { name });
    }

    // Set countdown duration (only when paused) - also reset elapsedTime
    function setDuration(durationMs: number) {
        if (timer?.isRunning) {
            return;
        }
        updateTimer(timerId, { duration: durationMs, elapsedTime: 0 });
    }

    // Set timer type
    function setType(type: TimerType) {
        updateTimer(timerId, { timerType: type });
    }

    // Edit elapsed time (manual adjustment when paused)
    function editElapsedTime(newElapsedMs: number) {
        if (!timer || timer.isRunning) {
            return;
        }

        updateTimer(timerId, { elapsedTime: newElapsedMs });
    }

    // Toggle show total time
    function toggleShowTotal() {
        if (!timer) {
            return;
        }
        updateTimer(timerId, { showTotal: !timer.showTotal });
    }

    // Calculate total time since first start
    function calcTotalTimeElapsed(): number {
        if (!timer?.firstStartTime) {
            return 0;
        }

        const firstStart =
            timer.firstStartTime instanceof Date
                ? timer.firstStartTime.getTime()
                : new Date(timer.firstStartTime).getTime();

        return Date.now() - firstStart;
    }

    // Completion percentage (for countdown/pomodoro)
    function calcCompletionPercentage(): number {
        if (!timer || timer.timerType === "stopwatch") {
            return 0;
        }
        if (!timer.duration) {
            return 0;
        }

        const elapsed = timer.elapsedTime ?? 0;
        return Math.min(100, (elapsed / timer.duration) * 100);
    }

    const totalTimeElapsed = calcTotalTimeElapsed();
    const completionPercentage = calcCompletionPercentage();

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
        totalTimeElapsed,
        completionPercentage,
    };
}
