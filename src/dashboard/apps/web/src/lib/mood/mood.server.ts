import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { db, type MoodEntry, moodEntries } from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";
import { emitDomainEvent } from "@/lib/events/event-bus.server";

export type MoodEntryRow = Omit<MoodEntry, "tags"> & { tags: string[] };

function toMoodRow(m: MoodEntry): MoodEntryRow {
    return {
        ...m,
        tags: m.tags ?? [],
    };
}

/**
 * Deterministic primary id so one check-in per day is enforced by the PK.
 * The (user_id, day) index is non-unique, so a `target: [userId, day]` upsert
 * would never conflict — keying the row id on user+day makes the PK do the job.
 */
function primaryId(userId: string, day: string): string {
    return `${userId}:${day}`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(day: string): string {
    if (!DAY_RE.test(day)) {
        throw new Error(`Invalid day key: ${day} (expected YYYY-MM-DD)`);
    }

    return day;
}

function clampScale(value: number): number {
    return Math.min(5, Math.max(1, Math.round(value)));
}

// ============================================
// List
// ============================================

export const listMoodEntries = createServerFn({ method: "GET" }).handler(async (): Promise<MoodEntryRow[]> => {
    const userId = await requireUserId();
    try {
        const rows = db
            .select()
            .from(moodEntries)
            .where(eq(moodEntries.userId, userId))
            .orderBy(desc(moodEntries.day))
            .all();
        return rows.map(toMoodRow);
    } catch (err) {
        console.error("[mood] listMoodEntries failed:", err);
        throw err;
    }
});

// ============================================
// Upsert today's (or any day's) primary check-in
// ============================================

export interface MoodCheckInInput {
    day: string;
    mood: number;
    energy: number;
    note: string;
    tags: string[];
}

export const upsertMoodEntry = createServerFn({ method: "POST" })
    .inputValidator((d: MoodCheckInInput) => d)
    .handler(async ({ data }): Promise<MoodEntryRow> => {
        const userId = await requireUserId();
        const day = assertDay(data.day);
        const id = primaryId(userId, day);
        const now = new Date().toISOString();
        const mood = clampScale(data.mood);
        const energy = clampScale(data.energy);
        const note = data.note.trim();
        const tags = data.tags.map((t) => t.trim()).filter(Boolean);

        try {
            db.insert(moodEntries)
                .values({
                    id,
                    userId,
                    day,
                    mood,
                    energy,
                    note,
                    tags,
                    createdAt: now,
                    updatedAt: now,
                })
                .onConflictDoUpdate({
                    target: moodEntries.id,
                    set: { mood, energy, note, tags, updatedAt: now },
                })
                .run();

            const saved = db.select().from(moodEntries).where(eq(moodEntries.id, id)).get();
            if (!saved) {
                throw new Error(`[mood] upsertMoodEntry: entry ${id} not found after upsert`);
            }

            emitDomainEvent(userId, "mood", { type: "changed", day });

            return toMoodRow(saved);
        } catch (err) {
            console.error("[mood] upsertMoodEntry failed:", err);
            throw err;
        }
    });

// ============================================
// Delete a day's entry
// ============================================

export const deleteMoodEntry = createServerFn({ method: "POST" })
    .inputValidator((d: { day: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();
        const day = assertDay(data.day);
        try {
            db.delete(moodEntries)
                .where(and(eq(moodEntries.userId, userId), eq(moodEntries.day, day)))
                .run();

            emitDomainEvent(userId, "mood", { type: "deleted", day });

            return { success: true };
        } catch (err) {
            console.error("[mood] deleteMoodEntry failed:", err);
            throw err;
        }
    });
