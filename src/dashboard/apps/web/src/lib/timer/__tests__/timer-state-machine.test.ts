import { DEFAULT_POMODORO_SETTINGS } from "@dashboard/shared";
import { describe, expect, it } from "vitest";
import type { Timer } from "@/drizzle";
import { applyAction, computeLiveElapsed, computePomodoroTarget } from "../timer-state-machine";

const T0_MS = new Date("2026-05-15T10:00:00Z").getTime();
const T_PLUS_5SEC_MS = T0_MS + 5_000;

function makeTimer(overrides: Partial<Timer> = {}): Timer {
    return {
        id: "t1",
        name: "Test",
        userId: "u1",
        timerType: "stopwatch",
        isRunning: 0,
        elapsedTime: 0,
        duration: null,
        laps: [],
        createdAt: new Date(T0_MS).toISOString(),
        updatedAt: new Date(T0_MS).toISOString(),
        showTotal: 0,
        firstStartTime: null,
        startTime: null,
        pomodoroSettings: null,
        pomodoroPhase: null,
        pomodoroSessionCount: 0,
        version: 1,
        ...overrides,
    };
}

describe("applyAction — start", () => {
    it("sets isRunning + startTime when stopped", () => {
        const r = applyAction(makeTimer(), { type: "start", nowMs: T0_MS });
        expect(r.next.isRunning).toBe(1);
        expect(r.next.startTime).toBe(new Date(T0_MS).toISOString());
        expect(r.next.firstStartTime).toBe(new Date(T0_MS).toISOString());
    });

    it("is idempotent when already running", () => {
        const running = makeTimer({ isRunning: 1, startTime: new Date(T0_MS).toISOString() });
        const r = applyAction(running, { type: "start", nowMs: T_PLUS_5SEC_MS });
        expect(r.next).toBe(running);
    });

    it("preserves firstStartTime if already set", () => {
        const firstStart = new Date(T0_MS - 60_000).toISOString();
        const t = makeTimer({ firstStartTime: firstStart });
        const r = applyAction(t, { type: "start", nowMs: T0_MS });
        expect(r.next.firstStartTime).toBe(firstStart);
    });
});

describe("applyAction — pause", () => {
    it("accumulates elapsed correctly", () => {
        const running = makeTimer({
            isRunning: 1,
            startTime: new Date(T0_MS).toISOString(),
            elapsedTime: 1_000,
        });
        const r = applyAction(running, { type: "pause", nowMs: T_PLUS_5SEC_MS });
        expect(r.next.isRunning).toBe(0);
        expect(r.next.elapsedTime).toBe(1_000 + 5_000);
        expect(r.next.startTime).toBeNull();
    });

    it("is idempotent when already paused", () => {
        const paused = makeTimer({ isRunning: 0, elapsedTime: 12_345 });
        const r = applyAction(paused, { type: "pause", nowMs: T_PLUS_5SEC_MS });
        expect(r.next).toBe(paused);
    });

    it("flags countdownComplete when elapsed >= duration", () => {
        const countdown = makeTimer({
            timerType: "countdown",
            duration: 60_000,
            isRunning: 1,
            startTime: new Date(T0_MS).toISOString(),
            elapsedTime: 58_000,
        });
        // 58000 persisted + 5000 session = 63000 > 60000
        const r = applyAction(countdown, { type: "pause", nowMs: T_PLUS_5SEC_MS });
        expect(r.countdownComplete).toBe(true);
    });

    it("does not flag countdownComplete for stopwatch", () => {
        const sw = makeTimer({
            isRunning: 1,
            startTime: new Date(T0_MS).toISOString(),
            elapsedTime: 0,
        });
        const r = applyAction(sw, { type: "pause", nowMs: T_PLUS_5SEC_MS });
        expect(r.countdownComplete).toBeFalsy();
    });
});

describe("applyAction — reset", () => {
    it("clears state and pomodoro phase", () => {
        const pomo = makeTimer({
            timerType: "pomodoro",
            isRunning: 1,
            elapsedTime: 12_345,
            pomodoroPhase: "long_break",
            pomodoroSessionCount: 8,
            laps: [{ number: 1, lapTime: 1000, splitTime: 1000, timestamp: new Date(T0_MS).toISOString() }],
        });
        const r = applyAction(pomo, { type: "reset" });
        expect(r.next.elapsedTime).toBe(0);
        expect(r.next.isRunning).toBe(0);
        expect(r.next.pomodoroPhase).toBe("work");
        expect(r.next.pomodoroSessionCount).toBe(0);
        expect(r.next.laps).toEqual([]);
        expect(r.next.firstStartTime).toBeNull();
    });
});

describe("applyAction — lap", () => {
    it("appends correct lapTime + splitTime", () => {
        const running = makeTimer({
            isRunning: 1,
            startTime: new Date(T0_MS).toISOString(),
            elapsedTime: 10_000,
            laps: [{ number: 1, lapTime: 4_000, splitTime: 4_000, timestamp: new Date(T0_MS).toISOString() }],
        });
        const r = applyAction(running, { type: "lap", nowMs: T_PLUS_5SEC_MS });
        expect(r.next.laps).toHaveLength(2);
        const laps = r.next.laps as Array<{ number: number; lapTime: number; splitTime: number; timestamp: string }>;
        // splitTime = 10000 persisted + 5000 session = 15000
        expect(laps[1].splitTime).toBe(15_000);
        // lapTime = splitTime - sum of previous laps = 15000 - 4000 = 11000
        expect(laps[1].lapTime).toBe(11_000);
    });
});

describe("applyAction — advance_pomodoro_phase", () => {
    it("work → short_break after first session", () => {
        const pomo = makeTimer({
            timerType: "pomodoro",
            pomodoroPhase: "work",
            pomodoroSessionCount: 0,
        });
        const r = applyAction(pomo, { type: "advance_pomodoro_phase" });
        expect(r.next.pomodoroSessionCount).toBe(1);
        expect(r.next.pomodoroPhase).toBe("short_break");
        expect(r.phaseTransition?.toPhase).toBe("short_break");
    });

    it("work → long_break after 4 sessions (mod 4 = 0)", () => {
        const pomo = makeTimer({
            timerType: "pomodoro",
            pomodoroPhase: "work",
            pomodoroSessionCount: 3,
        });
        const r = applyAction(pomo, { type: "advance_pomodoro_phase" });
        expect(r.next.pomodoroSessionCount).toBe(4);
        expect(r.next.pomodoroPhase).toBe("long_break");
        expect(r.phaseTransition?.toPhase).toBe("long_break");
    });

    it("short_break → work, sessionCount unchanged", () => {
        const pomo = makeTimer({
            timerType: "pomodoro",
            pomodoroPhase: "short_break",
            pomodoroSessionCount: 1,
        });
        const r = applyAction(pomo, { type: "advance_pomodoro_phase" });
        expect(r.next.pomodoroPhase).toBe("work");
        expect(r.next.pomodoroSessionCount).toBe(1); // breaks don't increment
    });

    it("resets elapsedTime to 0 on advance", () => {
        const pomo = makeTimer({
            timerType: "pomodoro",
            pomodoroPhase: "work",
            elapsedTime: 25 * 60 * 1000,
        });
        const r = applyAction(pomo, { type: "advance_pomodoro_phase" });
        expect(r.next.elapsedTime).toBe(0);
    });

    it("is a no-op for non-pomodoro timers", () => {
        const sw = makeTimer({ timerType: "stopwatch" });
        const r = applyAction(sw, { type: "advance_pomodoro_phase" });
        expect(r.next).toBe(sw);
    });
});

describe("computeLiveElapsed", () => {
    it("returns persisted elapsed when paused", () => {
        const t = makeTimer({ isRunning: 0, elapsedTime: 12_345 });
        expect(computeLiveElapsed(t, T0_MS)).toBe(12_345);
    });

    it("adds session elapsed when running", () => {
        const t = makeTimer({
            isRunning: 1,
            startTime: new Date(T0_MS).toISOString(),
            elapsedTime: 1_000,
        });
        expect(computeLiveElapsed(t, T_PLUS_5SEC_MS)).toBe(6_000);
    });
});

describe("computePomodoroTarget", () => {
    it("returns workDuration for pomodoro work phase", () => {
        const t = makeTimer({ timerType: "pomodoro", pomodoroPhase: "work" });
        expect(computePomodoroTarget(t)).toBe(DEFAULT_POMODORO_SETTINGS.workDuration);
    });

    it("returns shortBreakDuration for short_break phase", () => {
        const t = makeTimer({ timerType: "pomodoro", pomodoroPhase: "short_break" });
        expect(computePomodoroTarget(t)).toBe(DEFAULT_POMODORO_SETTINGS.shortBreakDuration);
    });

    it("returns longBreakDuration for long_break phase", () => {
        const t = makeTimer({ timerType: "pomodoro", pomodoroPhase: "long_break" });
        expect(computePomodoroTarget(t)).toBe(DEFAULT_POMODORO_SETTINGS.longBreakDuration);
    });

    it("returns duration for stopwatch", () => {
        const t = makeTimer({ timerType: "stopwatch", duration: 5_000 });
        expect(computePomodoroTarget(t)).toBe(5_000);
    });

    it("returns null for stopwatch without duration", () => {
        const t = makeTimer({ timerType: "stopwatch" });
        expect(computePomodoroTarget(t)).toBeNull();
    });
});
