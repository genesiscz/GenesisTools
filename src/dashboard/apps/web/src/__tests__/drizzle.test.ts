/**
 * Drizzle ORM Tests
 *
 * Tests for type-safe database operations with Drizzle
 */

import { desc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, test, vi } from "vitest";
import { activityLogs, db, readingItems, sqlite, timers } from "@/drizzle";
import { updateReadingItemForUser } from "@/lib/reading/reading.server";
import { queryFocusStatsForUser, queryProductivityStatsForUser } from "@/lib/timer/timer-sync.server";

describe("Drizzle ORM - Timers", () => {
    const testUserId = `test-user-${Date.now()}`;
    const testTimerId = `timer-${Date.now()}`;

    afterAll(async () => {
        // Cleanup test data
        await db.delete(timers).where(eq(timers.userId, testUserId));
        await db.delete(activityLogs).where(eq(activityLogs.userId, testUserId));
    });

    test("insert timer", async () => {
        const newTimer = {
            id: testTimerId,
            name: "Test Timer",
            timerType: "stopwatch" as const,
            isRunning: 0,
            elapsedTime: 0,
            duration: null,
            laps: [],
            userId: testUserId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            showTotal: 1,
            firstStartTime: null,
            startTime: null,
            pomodoroSettings: null,
            pomodoroPhase: null,
            pomodoroSessionCount: 0,
        };

        await db.insert(timers).values(newTimer);

        const result = await db.select().from(timers).where(eq(timers.id, testTimerId));

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("Test Timer");
        expect(result[0].timerType).toBe("stopwatch");
        expect(result[0].userId).toBe(testUserId);
    });

    test("select timer by user ID", async () => {
        const results = await db
            .select()
            .from(timers)
            .where(eq(timers.userId, testUserId))
            .orderBy(desc(timers.createdAt));

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].id).toBe(testTimerId);
    });

    test("update timer", async () => {
        await db
            .update(timers)
            .set({
                name: "Updated Timer",
                elapsedTime: 5000,
                updatedAt: new Date().toISOString(),
            })
            .where(eq(timers.id, testTimerId));

        const result = await db.select().from(timers).where(eq(timers.id, testTimerId));

        expect(result[0].name).toBe("Updated Timer");
        expect(result[0].elapsedTime).toBe(5000);
    });

    test("upsert timer (insert on conflict)", async () => {
        const timerId = `timer-upsert-${Date.now()}`;
        const initialTimer = {
            id: timerId,
            name: "Initial Name",
            timerType: "countdown" as const,
            isRunning: 0,
            elapsedTime: 0,
            duration: 60000,
            laps: [],
            userId: testUserId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            showTotal: 0,
            firstStartTime: null,
            startTime: null,
            pomodoroSettings: null,
            pomodoroPhase: null,
            pomodoroSessionCount: 0,
        };

        // First insert
        await db.insert(timers).values(initialTimer);

        // Upsert (update on conflict)
        await db
            .insert(timers)
            .values({ ...initialTimer, name: "Updated Name", elapsedTime: 10000 })
            .onConflictDoUpdate({
                target: timers.id,
                set: {
                    name: "Updated Name",
                    elapsedTime: 10000,
                    updatedAt: new Date().toISOString(),
                },
            });

        const result = await db.select().from(timers).where(eq(timers.id, timerId));

        expect(result[0].name).toBe("Updated Name");
        expect(result[0].elapsedTime).toBe(10000);

        // Cleanup
        await db.delete(timers).where(eq(timers.id, timerId));
    });

    test("delete timer", async () => {
        const timerId = `timer-delete-${Date.now()}`;

        await db.insert(timers).values({
            id: timerId,
            name: "To Delete",
            timerType: "stopwatch" as const,
            isRunning: 0,
            elapsedTime: 0,
            duration: null,
            laps: [],
            userId: testUserId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            showTotal: 0,
            firstStartTime: null,
            startTime: null,
            pomodoroSettings: null,
            pomodoroPhase: null,
            pomodoroSessionCount: 0,
        });

        await db.delete(timers).where(eq(timers.id, timerId));

        const result = await db.select().from(timers).where(eq(timers.id, timerId));

        expect(result).toHaveLength(0);
    });

    test("timer with JSON fields (laps)", async () => {
        const timerId = `timer-laps-${Date.now()}`;
        const lapsData = [
            { number: 1, lapTime: 1000, splitTime: 1000, timestamp: new Date().toISOString() },
            { number: 2, lapTime: 1500, splitTime: 2500, timestamp: new Date().toISOString() },
        ];

        await db.insert(timers).values({
            id: timerId,
            name: "Lap Timer",
            timerType: "stopwatch" as const,
            isRunning: 0,
            elapsedTime: 2500,
            duration: null,
            laps: lapsData,
            userId: testUserId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            showTotal: 0,
            firstStartTime: null,
            startTime: null,
            pomodoroSettings: null,
            pomodoroPhase: null,
            pomodoroSessionCount: 0,
        });

        const result = await db.select().from(timers).where(eq(timers.id, timerId));

        expect(result[0].laps).toEqual(lapsData);

        // Cleanup
        await db.delete(timers).where(eq(timers.id, timerId));
    });

    test("timer with pomodoro settings", async () => {
        const timerId = `timer-pomodoro-${Date.now()}`;
        const pomodoroSettings = {
            workDuration: 25 * 60 * 1000,
            shortBreakDuration: 5 * 60 * 1000,
            longBreakDuration: 15 * 60 * 1000,
            sessionsBeforeLongBreak: 4,
        };

        await db.insert(timers).values({
            id: timerId,
            name: "Pomodoro Timer",
            timerType: "pomodoro" as const,
            isRunning: 0,
            elapsedTime: 0,
            duration: 25 * 60 * 1000,
            laps: [],
            userId: testUserId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            showTotal: 0,
            firstStartTime: null,
            startTime: null,
            pomodoroSettings: pomodoroSettings,
            pomodoroPhase: "work",
            pomodoroSessionCount: 1,
        });

        const result = await db.select().from(timers).where(eq(timers.id, timerId));

        expect(result[0].pomodoroSettings).toEqual(pomodoroSettings);
        expect(result[0].pomodoroPhase).toBe("work");
        expect(result[0].pomodoroSessionCount).toBe(1);

        // Cleanup
        await db.delete(timers).where(eq(timers.id, timerId));
    });
});

describe("Drizzle ORM - Activity Logs", () => {
    const testUserId = `test-user-logs-${Date.now()}`;
    const testTimerId = `timer-logs-${Date.now()}`;

    afterAll(async () => {
        // Cleanup
        await db.delete(activityLogs).where(eq(activityLogs.userId, testUserId));
    });

    test("insert activity log", async () => {
        const logId = `log-${Date.now()}`;

        await db.insert(activityLogs).values({
            id: logId,
            timerId: testTimerId,
            timerName: "Test Timer",
            userId: testUserId,
            eventType: "start",
            timestamp: new Date().toISOString(),
            elapsedAtEvent: 0,
            sessionDuration: null,
            previousValue: null,
            newValue: null,
            metadata: {},
        });

        const result = await db.select().from(activityLogs).where(eq(activityLogs.id, logId));

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("start");
        expect(result[0].timerId).toBe(testTimerId);
    });

    test("insert activity log with metadata", async () => {
        const logId = `log-meta-${Date.now()}`;
        const metadata = { notes: "Important session", tags: ["work", "project-x"] };

        await db.insert(activityLogs).values({
            id: logId,
            timerId: testTimerId,
            timerName: "Test Timer",
            userId: testUserId,
            eventType: "pause",
            timestamp: new Date().toISOString(),
            elapsedAtEvent: 5000,
            sessionDuration: 5000,
            previousValue: null,
            newValue: null,
            metadata: metadata,
        });

        const result = await db.select().from(activityLogs).where(eq(activityLogs.id, logId));

        expect(result[0].metadata).toEqual(metadata);
        expect(result[0].sessionDuration).toBe(5000);
    });

    test("query activity logs by user", async () => {
        const results = await db
            .select()
            .from(activityLogs)
            .where(eq(activityLogs.userId, testUserId))
            .orderBy(desc(activityLogs.timestamp));

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].userId).toBe(testUserId);
    });
});

describe("activity aggregate queries", () => {
    const userId = `aggregate-user-${Date.now()}`;
    const otherUserId = `aggregate-other-${Date.now()}`;
    const startIso = "2026-10-01T00:00:00.000Z";
    const endIso = "2026-10-03T00:00:00.000Z";

    afterAll(() => {
        db.delete(activityLogs)
            .where(inArray(activityLogs.userId, [userId, otherUserId]))
            .run();
    });

    test("aggregates pause durations and completed work phases in SQL with user and range boundaries", () => {
        const base = {
            timerName: "Aggregate timer",
            elapsedAtEvent: 0,
            sessionDuration: null,
            metadata: {},
        };
        db.insert(activityLogs)
            .values([
                {
                    ...base,
                    id: `${userId}-pause-a1`,
                    timerId: "timer-a",
                    userId,
                    eventType: "pause",
                    timestamp: startIso,
                    previousValue: 0,
                    newValue: 1_000,
                },
                {
                    ...base,
                    id: `${userId}-pause-a2`,
                    timerId: "timer-a",
                    userId,
                    eventType: "pause",
                    timestamp: "2026-10-01T12:00:00.000Z",
                    previousValue: 1_000,
                    newValue: 4_000,
                },
                {
                    ...base,
                    id: `${userId}-pause-b1`,
                    timerId: "timer-b",
                    userId,
                    eventType: "pause",
                    timestamp: "2026-10-02T12:00:00.000Z",
                    previousValue: 0,
                    newValue: 2_000,
                },
                {
                    ...base,
                    id: `${userId}-invalid-pause`,
                    timerId: "timer-b",
                    userId,
                    eventType: "pause",
                    timestamp: "2026-10-02T13:00:00.000Z",
                    previousValue: 2_000,
                    newValue: 2_000,
                },
                {
                    ...base,
                    id: `${userId}-work-phase`,
                    timerId: "timer-a",
                    userId,
                    eventType: "pomodoro_phase_change",
                    timestamp: "2026-10-02T14:00:00.000Z",
                    previousValue: 1_000_000,
                    newValue: 0,
                    metadata: { fromPhase: "work", durationMs: 1_500_000 },
                },
                {
                    ...base,
                    id: `${userId}-break-phase`,
                    timerId: "timer-a",
                    userId,
                    eventType: "pomodoro_phase_change",
                    timestamp: "2026-10-02T15:00:00.000Z",
                    previousValue: 0,
                    newValue: 0,
                    metadata: { fromPhase: "short_break", durationMs: 300_000 },
                },
                {
                    ...base,
                    id: `${otherUserId}-pause`,
                    timerId: "timer-private",
                    userId: otherUserId,
                    eventType: "pause",
                    timestamp: "2026-10-01T12:00:00.000Z",
                    previousValue: 0,
                    newValue: 9_000,
                },
                {
                    ...base,
                    id: `${userId}-end-exclusive`,
                    timerId: "timer-a",
                    userId,
                    eventType: "pause",
                    timestamp: endIso,
                    previousValue: 0,
                    newValue: 8_000,
                },
            ])
            .run();

        // The work phase ran 1_500_000 ms, of which pause rows had covered 1_000_000: the unpaused
        // final run adds 500_000 and one session; the break phase adds nothing.
        expect(queryProductivityStatsForUser({ userId, startIso, endIso })).toEqual({
            totalTimeTracked: 506_000,
            sessionCount: 4,
            averageSessionDuration: 126_500,
            longestSession: 500_000,
            timerBreakdown: { "timer-a": 504_000, "timer-b": 2_000 },
            dailyBreakdown: { "2026-10-01": 4_000, "2026-10-02": 502_000 },
            pomodoroCompleted: 1,
        });
        expect(queryFocusStatsForUser({ userId, startIso, endIso })).toEqual({
            timeFocusedTodayMs: 506_000,
            sessionsToday: 4,
        });
    });

    test("returns zero-valued aggregates for an empty range", () => {
        expect(
            queryProductivityStatsForUser({
                userId,
                startIso: "2026-11-01T00:00:00.000Z",
                endIso: "2026-11-02T00:00:00.000Z",
            })
        ).toEqual({
            totalTimeTracked: 0,
            sessionCount: 0,
            averageSessionDuration: 0,
            longestSession: 0,
            timerBreakdown: {},
            dailyBreakdown: {},
            pomodoroCompleted: 0,
        });
    });

    test("uses the composite user/timestamp index for the aggregate range", () => {
        const plan = sqlite
            .prepare(
                "EXPLAIN QUERY PLAN SELECT count(*) FROM activity_logs WHERE user_id = ? AND timestamp >= ? AND timestamp < ?"
            )
            .all(userId, startIso, endIso) as Array<{ detail: string }>;

        expect(plan.some((row) => row.detail.includes("idx_activity_logs_user_timestamp"))).toBe(true);
    });
});

describe("reading item owner boundary", () => {
    const ownerId = `reading-owner-${Date.now()}`;
    const otherId = `reading-other-${Date.now()}`;
    const ownItemId = crypto.randomUUID();
    const foreignItemId = crypto.randomUUID();

    afterAll(() => {
        db.delete(readingItems)
            .where(inArray(readingItems.id, [ownItemId, foreignItemId]))
            .run();
    });

    test("returns only an owner-scoped update and emits success only for that row", () => {
        const now = new Date().toISOString();
        db.insert(readingItems)
            .values([
                { id: ownItemId, userId: ownerId, title: "Own title", createdAt: now, updatedAt: now },
                { id: foreignItemId, userId: otherId, title: "Private title", createdAt: now, updatedAt: now },
            ])
            .run();
        const onUpdated = vi.fn();

        const updated = updateReadingItemForUser({
            userId: ownerId,
            data: { id: ownItemId, patch: { title: "Updated title" } },
            onUpdated,
        });
        expect(updated.title).toBe("Updated title");
        expect(updated.userId).toBe(ownerId);
        expect(onUpdated).toHaveBeenCalledTimes(1);

        expect(() =>
            updateReadingItemForUser({
                userId: ownerId,
                data: { id: foreignItemId, patch: {} },
                onUpdated,
            })
        ).toThrow(`item ${foreignItemId} not found after update`);
        expect(() =>
            updateReadingItemForUser({
                userId: ownerId,
                data: { id: "missing-item", patch: {} },
                onUpdated,
            })
        ).toThrow("item missing-item not found after update");
        expect(onUpdated).toHaveBeenCalledTimes(1);

        const foreign = db.select().from(readingItems).where(eq(readingItems.id, foreignItemId)).get();
        expect(foreign?.title).toBe("Private title");
        expect(foreign?.userId).toBe(otherId);
    });

    test("a patch that names userId or id cannot move the row to another owner", () => {
        const hostilePatch = { title: "Renamed", userId: otherId, id: "hijacked-id" };

        const updated = updateReadingItemForUser({
            userId: ownerId,
            data: { id: ownItemId, patch: hostilePatch },
            onUpdated: vi.fn(),
        });

        expect(updated.title).toBe("Renamed");
        expect(updated.userId).toBe(ownerId);
        expect(updated.id).toBe(ownItemId);
        const stored = db.select().from(readingItems).where(eq(readingItems.id, ownItemId)).get();
        expect(stored?.userId).toBe(ownerId);
    });
});
