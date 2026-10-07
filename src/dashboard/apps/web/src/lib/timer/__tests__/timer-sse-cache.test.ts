import { describe, expect, it } from "vitest";
import type { Timer } from "@/drizzle";
import { timerQueryDirtiness } from "../timer-activity";
import { applyCommittedTimerEvent, recoverTimerQueries, type TimerQueryCache } from "../timer-sse-cache";

function timer(id: string): Timer {
    return {
        id,
        name: id,
        userId: "user-1",
        timerType: "stopwatch",
        isRunning: 0,
        elapsedTime: 0,
        duration: null,
        laps: [],
        createdAt: "2026-10-06T00:00:00.000Z",
        updatedAt: "2026-10-06T00:00:00.000Z",
        showTotal: 0,
        firstStartTime: null,
        startTime: null,
        pomodoroSettings: null,
        pomodoroPhase: null,
        pomodoroSessionCount: 0,
        version: 1,
    };
}

function fakeCache(initial: Timer[] = []): {
    cache: TimerQueryCache;
    invalidations: Array<readonly unknown[]>;
    timers: () => Timer[];
    patches: () => number;
} {
    const invalidations: Array<readonly unknown[]> = [];
    let current = initial;
    let patchCount = 0;

    return {
        cache: {
            setQueryData: (_key, updater) => {
                patchCount++;
                current = updater(current) as Timer[];
            },
            invalidateQueries: ({ queryKey }) => {
                invalidations.push(queryKey);
            },
        },
        invalidations,
        timers: () => current,
        patches: () => patchCount,
    };
}

describe("timer SSE cache contract", () => {
    it("marks only the aggregates affected by each persisted activity type", () => {
        expect(timerQueryDirtiness(["lap"])).toEqual({
            activityDirty: true,
            focusStatsDirty: false,
            focusSessionsDirty: false,
        });
        expect(timerQueryDirtiness(["pause"])).toEqual({
            activityDirty: true,
            focusStatsDirty: true,
            focusSessionsDirty: false,
        });
        expect(timerQueryDirtiness(["pomodoro_phase_change"])).toEqual({
            activityDirty: true,
            focusStatsDirty: true,
            focusSessionsDirty: true,
        });
        expect(timerQueryDirtiness([])).toEqual({
            activityDirty: false,
            focusStatsDirty: false,
            focusSessionsDirty: false,
        });
    });

    it("lets domain frames pass without duplicate query work", () => {
        const state = fakeCache([timer("one")]);

        applyCommittedTimerEvent(state.cache, "user-1", {
            type: "phase_changed",
            activityDirty: true,
            focusSessionsDirty: true,
        });

        expect(state.patches()).toBe(0);
        expect(state.invalidations).toEqual([]);
    });

    it("patches one committed snapshot and invalidates each dirty aggregate once", () => {
        const state = fakeCache([timer("one"), timer("two")]);
        const changed = { ...timer("two"), elapsedTime: 60_000, version: 2 };

        applyCommittedTimerEvent(state.cache, "user-1", {
            type: "timer_changed",
            snapshot: changed,
            activityDirty: true,
            focusSessionsDirty: true,
        });

        expect(state.patches()).toBe(1);
        expect(state.timers().find((item) => item.id === "two")).toEqual(changed);
        expect(state.invalidations).toEqual([
            ["activity-logs", "user-1"],
            ["focus-sessions-today", "user-1"],
        ]);
    });

    it("refreshes focus totals for a pause without refreshing completed Pomodoro blocks", () => {
        const state = fakeCache([timer("one")]);

        applyCommittedTimerEvent(state.cache, "user-1", {
            type: "timer_changed",
            snapshot: { ...timer("one"), elapsedTime: 60_000, version: 2 },
            activityDirty: true,
            focusStatsDirty: true,
        });

        expect(state.invalidations).toEqual([
            ["activity-logs", "user-1"],
            ["focus-stats-today", "user-1"],
        ]);
    });

    it("does not refresh activity aggregates for metadata-only snapshots", () => {
        const state = fakeCache([timer("one")]);

        applyCommittedTimerEvent(state.cache, "user-1", {
            type: "timer_changed",
            snapshot: { ...timer("one"), name: "Renamed", version: 2 },
            activityDirty: false,
        });

        expect(state.patches()).toBe(1);
        expect(state.invalidations).toEqual([]);
    });

    it("invalidates timers and all aggregates once on open or reconnect", () => {
        const state = fakeCache();

        recoverTimerQueries(state.cache, "user-1");

        expect(state.invalidations).toEqual([
            ["timers", "user-1"],
            ["activity-logs", "user-1"],
            ["focus-stats-today", "user-1"],
            ["focus-sessions-today", "user-1"],
        ]);
    });
});
