/**
 * Pure functions for timer state transitions.
 *
 * Operates on the drizzle DB row shape (Timer = typeof timers.$inferSelect).
 * Server reads current state from DB, calls these functions, writes result back.
 * Client never computes a new state — only sends actions.
 *
 * Time is passed in as `now` (ms since epoch) to keep functions pure + testable.
 */

import type { PomodoroPhase, PomodoroSettings } from "@dashboard/shared";
import { DEFAULT_POMODORO_SETTINGS } from "@dashboard/shared";
import type { Timer } from "@/drizzle";

export type LapRow = {
    number: number;
    lapTime: number;
    splitTime: number;
    timestamp: string; // ISO string (drizzle stores as text)
};

export type TimerAction =
    | { type: "start"; nowMs: number }
    | { type: "pause"; nowMs: number }
    | { type: "reset" }
    | { type: "lap"; nowMs: number }
    | { type: "advance_pomodoro_phase" }
    | { type: "set_pomodoro_settings"; settings: PomodoroSettings }
    | {
          type: "update_metadata";
          patch: Partial<Pick<Timer, "name" | "showTotal" | "duration" | "elapsedTime" | "timerType">>;
      };

export interface TransitionResult {
    next: Timer;
    /** Fire a "phase_completed" event for SSE/celebration */
    phaseTransition?: { fromPhase: PomodoroPhase; toPhase: PomodoroPhase; sessionCount: number };
    /** Fire a "countdown_complete" event */
    countdownComplete?: boolean;
}

export function applyAction(current: Timer, action: TimerAction): TransitionResult {
    switch (action.type) {
        case "start": {
            if (current.isRunning) {
                return { next: current }; // idempotent
            }

            return {
                next: {
                    ...current,
                    isRunning: 1,
                    startTime: new Date(action.nowMs).toISOString(),
                    firstStartTime: current.firstStartTime ?? new Date(action.nowMs).toISOString(),
                },
            };
        }

        case "pause": {
            if (!current.isRunning) {
                return { next: current }; // idempotent
            }

            const sessionElapsed = current.startTime ? action.nowMs - new Date(current.startTime).getTime() : 0;
            const newElapsed = current.elapsedTime + sessionElapsed;
            const countdownComplete =
                current.timerType === "countdown" && current.duration != null && newElapsed >= current.duration;

            return {
                next: {
                    ...current,
                    isRunning: 0,
                    elapsedTime: newElapsed,
                    startTime: null,
                },
                countdownComplete,
            };
        }

        case "reset": {
            return {
                next: {
                    ...current,
                    isRunning: 0,
                    elapsedTime: 0,
                    startTime: null,
                    firstStartTime: null,
                    laps: [],
                    pomodoroPhase: current.timerType === "pomodoro" ? "work" : current.pomodoroPhase,
                    pomodoroSessionCount: current.timerType === "pomodoro" ? 0 : (current.pomodoroSessionCount ?? 0),
                },
            };
        }

        case "lap": {
            const sessionElapsed = current.startTime ? action.nowMs - new Date(current.startTime).getTime() : 0;
            const splitTime = current.elapsedTime + sessionElapsed;
            const existingLaps = (current.laps as LapRow[]) ?? [];
            const previousSplitTotal = existingLaps.reduce((acc, l) => acc + l.lapTime, 0);
            const lapTime = splitTime - previousSplitTotal;
            const newLap: LapRow = {
                number: existingLaps.length + 1,
                lapTime,
                splitTime,
                timestamp: new Date(action.nowMs).toISOString(),
            };

            return {
                next: {
                    ...current,
                    laps: [...existingLaps, newLap] as Timer["laps"],
                },
            };
        }

        case "advance_pomodoro_phase": {
            if (current.timerType !== "pomodoro") {
                return { next: current };
            }

            const settings = (current.pomodoroSettings as PomodoroSettings | null) ?? DEFAULT_POMODORO_SETTINGS;
            const phase: PomodoroPhase = (current.pomodoroPhase as PomodoroPhase) ?? "work";
            let toPhase: PomodoroPhase;
            let newSessionCount = current.pomodoroSessionCount ?? 0;

            if (phase === "work") {
                newSessionCount += 1;
                toPhase = newSessionCount % settings.sessionsBeforeLongBreak === 0 ? "long_break" : "short_break";
            } else {
                toPhase = "work";
            }

            return {
                next: {
                    ...current,
                    pomodoroPhase: toPhase,
                    pomodoroSessionCount: newSessionCount,
                    elapsedTime: 0,
                    isRunning: 0,
                    startTime: null,
                },
                phaseTransition: { fromPhase: phase, toPhase, sessionCount: newSessionCount },
            };
        }

        case "set_pomodoro_settings": {
            return {
                next: {
                    ...current,
                    pomodoroSettings: action.settings as Timer["pomodoroSettings"],
                },
            };
        }

        case "update_metadata": {
            return { next: { ...current, ...action.patch } };
        }
    }
}

/** Compute the phase target in ms for the current timer state. */
export function computePomodoroTarget(timer: Timer): number | null {
    if (timer.timerType !== "pomodoro") {
        return timer.duration ?? null;
    }

    const settings = (timer.pomodoroSettings as PomodoroSettings | null) ?? DEFAULT_POMODORO_SETTINGS;
    const phase: PomodoroPhase = (timer.pomodoroPhase as PomodoroPhase) ?? "work";

    if (phase === "work") {
        return settings.workDuration;
    }

    if (phase === "short_break") {
        return settings.shortBreakDuration;
    }

    return settings.longBreakDuration;
}

/** Live elapsed for display = persisted elapsed + (nowMs - startTime if running). */
export function computeLiveElapsed(timer: Timer, nowMs: number): number {
    if (!timer.isRunning || !timer.startTime) {
        return timer.elapsedTime;
    }

    return timer.elapsedTime + (nowMs - new Date(timer.startTime).getTime());
}
