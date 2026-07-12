import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray } from "drizzle-orm";
import { db, type Habit, habitEntries, habits, type NewHabit } from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";
import { emitDomainEvent } from "@/lib/events/event-bus.server";
import { dayKeyRange, todayKey, weekStartKey } from "./habits-dates";

// ============================================
// Types
// ============================================

/** How many days of heatmap history the card renders (~12 weeks + padding). */
export const HEATMAP_DAYS = 7 * 13;

export interface HabitHeatmapDay {
    day: string;
    count: number;
}

/** A habit enriched with derived stats computed from its entries. */
export interface HabitWithStats {
    id: string;
    name: string;
    color: string;
    icon: string;
    cadence: "daily" | "weekly";
    targetPerWeek: number;
    sortOrder: number;
    createdAt: string;
    /** Last HEATMAP_DAYS days, oldest-first, every day present (count 0 when empty). */
    heatmap: HabitHeatmapDay[];
    /** Current run of consecutive completed days ending today (or yesterday). */
    currentStreak: number;
    /** Completed days in the current Monday-anchored week. */
    weekCount: number;
    /** Whether today already has an entry. */
    doneToday: boolean;
    /** All-time completed days. */
    totalDays: number;
}

function asCadence(value: string): "daily" | "weekly" {
    return value === "weekly" ? "weekly" : "daily";
}

/**
 * Compute the current streak from a set of completed day-keys. The streak is
 * "alive until you miss a full day" (plain GitHub behaviour): an un-done today
 * does NOT break a streak that ran through yesterday — it stays alive until
 * tomorrow. A done today extends it.
 */
function computeStreak(doneDays: Set<string>): number {
    const start = new Date();
    if (!doneDays.has(todayKey())) {
        // Today not done yet — count from yesterday so the streak survives the day.
        start.setDate(start.getDate() - 1);
    }

    let streak = 0;
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12, 0, 0, 0);
    for (;;) {
        const y = cursor.getFullYear();
        const m = String(cursor.getMonth() + 1).padStart(2, "0");
        const d = String(cursor.getDate()).padStart(2, "0");
        const key = `${y}-${m}-${d}`;
        if (!doneDays.has(key)) {
            break;
        }

        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
}

function enrichHabit(habit: Habit, doneDays: Set<string>): HabitWithStats {
    const range = dayKeyRange(HEATMAP_DAYS);
    const heatmap: HabitHeatmapDay[] = range.map((day) => ({
        day,
        count: doneDays.has(day) ? 1 : 0,
    }));

    const weekStart = weekStartKey();
    let weekCount = 0;
    for (const day of doneDays) {
        if (day >= weekStart) {
            weekCount += 1;
        }
    }

    return {
        id: habit.id,
        name: habit.name,
        color: habit.color,
        icon: habit.icon,
        cadence: asCadence(habit.cadence),
        targetPerWeek: habit.targetPerWeek,
        sortOrder: habit.sortOrder,
        createdAt: habit.createdAt,
        heatmap,
        currentStreak: computeStreak(doneDays),
        weekCount,
        doneToday: doneDays.has(todayKey()),
        totalDays: doneDays.size,
    };
}

// ============================================
// List (with derived stats)
// ============================================

export const listHabits = createServerFn({ method: "GET" }).handler(async (): Promise<HabitWithStats[]> => {
    const userId = await requireUserId();
    try {
        const rows = db
            .select()
            .from(habits)
            .where(and(eq(habits.userId, userId), eq(habits.archived, 0)))
            .all();

        if (rows.length === 0) {
            return [];
        }

        const ids = rows.map((h) => h.id);
        const entries = db
            .select({ habitId: habitEntries.habitId, day: habitEntries.day })
            .from(habitEntries)
            .where(and(eq(habitEntries.userId, userId), inArray(habitEntries.habitId, ids)))
            .all();

        const byHabit = new Map<string, Set<string>>();
        for (const id of ids) {
            byHabit.set(id, new Set<string>());
        }
        for (const entry of entries) {
            byHabit.get(entry.habitId)?.add(entry.day);
        }

        return rows
            .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))
            .map((h) => enrichHabit(h, byHabit.get(h.id) ?? new Set<string>()));
    } catch (err) {
        console.error("[habits] listHabits failed:", err);
        throw err;
    }
});

// ============================================
// Create
// ============================================

export interface CreateHabitInput {
    name: string;
    color: string;
    icon: string;
    cadence: "daily" | "weekly";
    targetPerWeek: number;
}

export const createHabit = createServerFn({ method: "POST" })
    .inputValidator((d: CreateHabitInput) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();
        try {
            const now = new Date().toISOString();
            const maxOrder = db
                .select({ sortOrder: habits.sortOrder })
                .from(habits)
                .where(eq(habits.userId, userId))
                .all()
                .reduce((max, h) => Math.max(max, h.sortOrder), -1);

            const row: NewHabit = {
                id: crypto.randomUUID(),
                userId,
                name: data.name,
                color: data.color,
                icon: data.icon,
                cadence: data.cadence,
                targetPerWeek: data.targetPerWeek,
                sortOrder: maxOrder + 1,
                archived: 0,
                createdAt: now,
                updatedAt: now,
            };
            db.insert(habits).values(row).run();

            emitDomainEvent(userId, "habits", { type: "created" });
            return { success: true };
        } catch (err) {
            console.error("[habits] createHabit failed:", err);
            throw err;
        }
    });

// ============================================
// Toggle today
// ============================================

export const toggleHabitToday = createServerFn({ method: "POST" })
    .inputValidator((d: { habitId: string }) => d)
    .handler(async ({ data }): Promise<{ done: boolean }> => {
        const userId = await requireUserId();
        try {
            const owns = db
                .select({ id: habits.id })
                .from(habits)
                .where(and(eq(habits.id, data.habitId), eq(habits.userId, userId)))
                .get();
            if (!owns) {
                throw new Error(`[habits] toggleHabitToday: habit ${data.habitId} not found for user`);
            }

            const day = todayKey();
            const existing = db
                .select({ id: habitEntries.id })
                .from(habitEntries)
                .where(and(eq(habitEntries.habitId, data.habitId), eq(habitEntries.day, day)))
                .get();

            if (existing) {
                db.delete(habitEntries).where(eq(habitEntries.id, existing.id)).run();
                emitDomainEvent(userId, "habits", { type: "toggled" });
                return { done: false };
            }

            db.insert(habitEntries)
                .values({
                    id: crypto.randomUUID(),
                    userId,
                    habitId: data.habitId,
                    day,
                    count: 1,
                    createdAt: new Date().toISOString(),
                })
                .run();
            emitDomainEvent(userId, "habits", { type: "toggled" });
            return { done: true };
        } catch (err) {
            console.error("[habits] toggleHabitToday failed:", err);
            throw err;
        }
    });

// ============================================
// Archive (soft-delete)
// ============================================

export const archiveHabit = createServerFn({ method: "POST" })
    .inputValidator((d: { habitId: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();
        try {
            db.update(habits)
                .set({ archived: 1, updatedAt: new Date().toISOString() })
                .where(and(eq(habits.id, data.habitId), eq(habits.userId, userId)))
                .run();

            emitDomainEvent(userId, "habits", { type: "archived" });
            return { success: true };
        } catch (err) {
            console.error("[habits] archiveHabit failed:", err);
            throw err;
        }
    });
