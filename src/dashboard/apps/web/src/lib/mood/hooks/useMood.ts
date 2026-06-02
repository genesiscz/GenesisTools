import type { MoodEntryRow } from "../mood.server";
import { addDays, localDayKey } from "../mood-scale";
import { useDeleteMoodMutation, useMoodEntriesQuery, useUpsertMoodMutation } from "./useMoodQueries";

export interface MoodCheckInValues {
    mood: number;
    energy: number;
    note: string;
    tags: string[];
}

export interface MoodTrendPoint {
    day: string;
    label: string;
    mood: number | null;
    energy: number | null;
}

export interface MoodInsights {
    avgMoodWeek: number | null;
    streak: number;
    loggedDays: number;
}

const WINDOW_DAYS = 30;

function buildTrend(entriesByDay: Map<string, MoodEntryRow>, today: string): MoodTrendPoint[] {
    const points: MoodTrendPoint[] = [];
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
        const day = addDays(today, -i);
        const entry = entriesByDay.get(day);
        const [, m, d] = day.split("-").map(Number);
        points.push({
            day,
            label: `${m}/${d}`,
            mood: entry ? entry.mood : null,
            energy: entry ? entry.energy : null,
        });
    }

    return points;
}

function computeStreak(entriesByDay: Map<string, MoodEntryRow>, today: string): number {
    // Streak counts consecutive logged days ending today or yesterday (so a
    // not-yet-logged "today" doesn't zero out an active streak before evening).
    let cursor = entriesByDay.has(today) ? today : addDays(today, -1);
    if (!entriesByDay.has(cursor)) {
        return 0;
    }

    let streak = 0;
    while (entriesByDay.has(cursor)) {
        streak++;
        cursor = addDays(cursor, -1);
    }

    return streak;
}

function computeInsights(entriesByDay: Map<string, MoodEntryRow>, today: string): MoodInsights {
    let weekSum = 0;
    let weekCount = 0;
    for (let i = 0; i < 7; i++) {
        const entry = entriesByDay.get(addDays(today, -i));
        if (entry) {
            weekSum += entry.mood;
            weekCount++;
        }
    }

    return {
        avgMoodWeek: weekCount > 0 ? Math.round((weekSum / weekCount) * 10) / 10 : null,
        streak: computeStreak(entriesByDay, today),
        loggedDays: entriesByDay.size,
    };
}

export function useMood(userId: string | null) {
    const query = useMoodEntriesQuery(userId);
    const upsertMut = useUpsertMoodMutation(userId);
    const deleteMut = useDeleteMoodMutation(userId);

    const entries: MoodEntryRow[] = query.data ?? [];
    const loading = query.isLoading;
    const initialized = !loading && query.data !== undefined;

    const today = localDayKey();
    const entriesByDay = new Map<string, MoodEntryRow>();
    for (const e of entries) {
        entriesByDay.set(e.day, e);
    }

    const todayEntry = entriesByDay.get(today) ?? null;
    const trend = buildTrend(entriesByDay, today);
    const insights = computeInsights(entriesByDay, today);

    async function saveCheckIn(values: MoodCheckInValues): Promise<MoodEntryRow | null> {
        if (!userId) {
            return null;
        }

        return upsertMut.mutateAsync({
            day: today,
            mood: values.mood,
            energy: values.energy,
            note: values.note,
            tags: values.tags,
        });
    }

    async function removeEntry(day: string): Promise<boolean> {
        if (!userId) {
            return false;
        }

        const result = await deleteMut.mutateAsync(day);
        return result.success;
    }

    return {
        entries,
        loading,
        initialized,
        error: query.error,
        today,
        todayEntry,
        trend,
        insights,
        saveCheckIn,
        removeEntry,
        saving: upsertMut.isPending,
    };
}
