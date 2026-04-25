import type { Timer } from "@dashboard/shared";
import { useEffect, useRef, useState } from "react";

/**
 * Hook that manages the timer display loop using requestAnimationFrame
 *
 * This hook provides accurate time tracking by calculating elapsed time
 * from the start timestamp rather than incrementing a counter
 */
export function useTimerEngine(timer: Timer | null | undefined) {
    // Derive isRunning directly from timer to avoid state lag
    const isRunning = timer?.isRunning ?? false;

    const [displayTime, setDisplayTime] = useState<number>(0);

    const animationFrameRef = useRef<number | null>(null);
    const lastUpdateRef = useRef<number>(0);

    // Calculate current elapsed time based on timer state
    function calculateElapsed(): number {
        if (!timer) {
            return 0;
        }

        const baseElapsed = timer.elapsedTime ?? 0;

        if (timer.isRunning && timer.startTime) {
            const startTime =
                timer.startTime instanceof Date ? timer.startTime.getTime() : new Date(timer.startTime).getTime();
            const now = Date.now();
            const sessionElapsed = now - startTime;

            if (timer.timerType === "countdown") {
                // Countdown: duration - elapsed
                const remaining = (timer.duration ?? 0) - (baseElapsed + sessionElapsed);
                return Math.max(0, remaining);
            }

            // Stopwatch/Pomodoro: accumulate elapsed
            return baseElapsed + sessionElapsed;
        }

        // Not running - return base elapsed or remaining for countdown
        if (timer.timerType === "countdown") {
            return Math.max(0, (timer.duration ?? 0) - baseElapsed);
        }

        return baseElapsed;
    }

    // Animation loop
    function tick() {
        const now = performance.now();

        // Throttle updates to ~60fps (16.67ms)
        if (now - lastUpdateRef.current >= 16) {
            const elapsed = calculateElapsed();
            setDisplayTime(elapsed);
            lastUpdateRef.current = now;
        }

        animationFrameRef.current = requestAnimationFrame(tick);
    }

    // Start/stop the animation loop based on timer running state
    useEffect(() => {
        if (isRunning) {
            // Start animation loop
            lastUpdateRef.current = performance.now();
            animationFrameRef.current = requestAnimationFrame(tick);
        } else {
            // Stop animation loop
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
            // Update to final elapsed time
            const elapsed = calculateElapsed();
            setDisplayTime(elapsed);
        }

        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
        };
    });

    // Update display time when timer changes externally (e.g., reset)
    useEffect(() => {
        if (!isRunning) {
            const elapsed = calculateElapsed();
            setDisplayTime(elapsed);
        }
    });

    return {
        displayTime,
        isRunning,
        calculateElapsed,
    };
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
