import { useEffect, useRef, useState } from "react";
import type { Timer } from "@/drizzle";
import { computeLiveElapsed, computePomodoroTarget } from "@/lib/timer/timer-state-machine";

/**
 * Display-only hook that manages the timer rAF loop.
 *
 * Reads elapsed from server snapshot and interpolates locally for smooth display.
 * Never writes — all mutations go through server action server functions.
 */
export function useTimerEngine(timer: Timer | null | undefined, options?: { onTargetReached?: () => void }) {
    const isRunning = Boolean(timer?.isRunning);

    const [nowMs, setNowMs] = useState(() => Date.now());
    const rafRef = useRef<number | null>(null);
    const targetReachedRef = useRef(false);

    useEffect(() => {
        if (!isRunning) {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }

            setNowMs(Date.now());
            return;
        }

        const tick = () => {
            setNowMs(Date.now());
            rafRef.current = requestAnimationFrame(tick);
        };

        rafRef.current = requestAnimationFrame(tick);

        return () => {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, [isRunning]);

    // Reset target-reached flag when server-confirmed state changes
    useEffect(() => {
        targetReachedRef.current = false;
    }, [timer?.elapsedTime, timer?.pomodoroPhase, timer?.startTime]);

    const displayTime = timer ? computeDisplayTime(timer, nowMs) : 0;

    const target = timer ? computePomodoroTarget(timer) : null;

    if (options?.onTargetReached && target != null && displayTime >= target && !targetReachedRef.current) {
        targetReachedRef.current = true;
        queueMicrotask(() => options.onTargetReached?.());
    }

    return {
        displayTime,
        isRunning,
    };
}

/**
 * Compute display time for the given timer.
 * For countdown: remaining time (clamped to 0).
 * For stopwatch/pomodoro: elapsed time.
 */
function computeDisplayTime(timer: Timer, nowMs: number): number {
    const elapsed = computeLiveElapsed(timer, nowMs);

    if (timer.timerType === "countdown") {
        return Math.max(0, (timer.duration ?? 0) - elapsed);
    }

    return elapsed;
}

/**
 * Format milliseconds to display string
 */
export function formatTime(ms: number, showMilliseconds = true): string {
    const totalSeconds = Math.floor(Math.abs(ms) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = Math.floor((Math.abs(ms) % 1000) / 10);

    let result = "";

    if (hours > 0) {
        result = `${hours.toString().padStart(2, "0")}:`;
    }

    result += `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

    if (showMilliseconds) {
        result += `.${milliseconds.toString().padStart(2, "0")}`;
    }

    return result;
}

/**
 * Format milliseconds to compact string (for laps)
 */
export function formatTimeCompact(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centiseconds = Math.floor((ms % 1000) / 10);

    if (minutes > 0) {
        return `${minutes}:${seconds.toString().padStart(2, "0")}.${centiseconds.toString().padStart(2, "0")}`;
    }

    return `${seconds}.${centiseconds.toString().padStart(2, "0")}`;
}

/**
 * Format milliseconds to human-readable duration (e.g., "5h 33m 11s")
 */
export function formatDurationHuman(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];

    if (hours > 0) {
        parts.push(`${hours}h`);
    }

    if (minutes > 0) {
        parts.push(`${minutes}m`);
    }

    if (seconds > 0 || parts.length === 0) {
        parts.push(`${seconds}s`);
    }

    return parts.join(" ");
}
