/**
 * Assistant Server Functions - REST-like CRUD endpoints
 *
 * Simple TanStack Start server functions for assistant features.
 * Uses Drizzle ORM for type-safe database operations.
 *
 * Architecture:
 * - TanStack Query on client calls these server functions
 * - refetchOnWindowFocus provides refresh-on-focus sync
 * - No PowerSync complexity - just REST-like endpoints
 */

import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { requireUserId } from "@/lib/auth/requireUser";
import {
    type AssistantBadge,
    type AssistantBlocker,
    type AssistantCelebration,
    type AssistantCommunication,
    type AssistantCompletion,
    type AssistantContextParking,
    type AssistantDeadlineRisk,
    type AssistantDecision,
    type AssistantDistraction,
    type AssistantEnergySnapshot,
    type AssistantHandoff,
    type AssistantStreak,
    type AssistantTask,
    type AssistantWeeklyReview,
    assistantBadges,
    assistantBlockers,
    assistantCelebrations,
    assistantCommunications,
    assistantCompletions,
    assistantContextParking,
    assistantDeadlineRisks,
    assistantDecisions,
    assistantDistractions,
    assistantEnergySnapshots,
    assistantHandoffs,
    assistantStreaks,
    assistantTasks,
    assistantWeeklyReviews,
    db,
    type NewAssistantBadge,
    type NewAssistantBlocker,
    type NewAssistantCelebration,
    type NewAssistantCommunication,
    type NewAssistantCompletion,
    type NewAssistantContextParking,
    type NewAssistantDeadlineRisk,
    type NewAssistantDecision,
    type NewAssistantDistraction,
    type NewAssistantEnergySnapshot,
    type NewAssistantHandoff,
    type NewAssistantStreak,
    type NewAssistantTask,
    type NewAssistantWeeklyReview,
} from "@/drizzle";

// ============================================
// Tasks CRUD
// ============================================

export const getAssistantTasks = createServerFn({
    method: "GET",
}).handler(async (): Promise<AssistantTask[]> => {
    const userId = await requireUserId();

    try {
        const results = db
            .select()
            .from(assistantTasks)
            .where(eq(assistantTasks.userId, userId))
            .orderBy(desc(assistantTasks.updatedAt))
            .all();

        return results;
    } catch (error) {
        console.error("[Assistant] getAssistantTasks error:", error);
        throw error;
    }
});

export const getAssistantTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<AssistantTask | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .select()
                .from(assistantTasks)
                .where(and(eq(assistantTasks.id, data.id), eq(assistantTasks.userId, userId)))
                .get();

            if (!result) {
                return null;
            }

            return {
                ...result,
            };
        } catch (error) {
            console.error("[Assistant] getAssistantTask error:", error);
            throw error;
        }
    });

export const createAssistantTask = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantTask, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantTask | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantTasks)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantTask error:", error);
            throw error;
        }
    });

export const updateAssistantTask = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantTask> }) => d)
    .handler(async ({ data: input }): Promise<AssistantTask | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(assistantTasks)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(and(eq(assistantTasks.id, input.id), eq(assistantTasks.userId, userId)))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantTask error:", error);
            throw error;
        }
    });

export const deleteAssistantTask = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();

        try {
            db.delete(assistantTasks)
                .where(and(eq(assistantTasks.id, data.id), eq(assistantTasks.userId, userId)))
                .run();
            return { success: true };
        } catch (error) {
            console.error("[Assistant] deleteAssistantTask error:", error);
            throw error;
        }
    });

// ============================================
// Context Parking CRUD
// ============================================

export const getAssistantContextParkings = createServerFn({
    method: "GET",
}).handler(async (): Promise<AssistantContextParking[]> => {
    const userId = await requireUserId();

    try {
        const results = db
            .select()
            .from(assistantContextParking)
            .where(eq(assistantContextParking.userId, userId))
            .orderBy(desc(assistantContextParking.parkedAt))
            .all();

        return results;
    } catch (error) {
        console.error("[Assistant] getAssistantContextParkings error:", error);
        throw error;
    }
});

export const createAssistantContextParking = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantContextParking, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantContextParking | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantContextParking)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantContextParking error:", error);
            throw error;
        }
    });

export const updateAssistantContextParking = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantContextParking> }) => d)
    .handler(async ({ data: input }): Promise<AssistantContextParking | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(assistantContextParking)
                .set(input.data)
                .where(
                    and(
                        eq(assistantContextParking.id, input.id),
                        eq(assistantContextParking.userId, userId)
                    )
                )
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantContextParking error:", error);
            throw error;
        }
    });

// ============================================
// Completions CRUD
// ============================================

export const getAssistantCompletions = createServerFn({
    method: "GET",
})
    .inputValidator((d: { limit?: number }) => d)
    .handler(async ({ data }): Promise<AssistantCompletion[]> => {
        const userId = await requireUserId();

        try {
            const results = db
                .select()
                .from(assistantCompletions)
                .where(eq(assistantCompletions.userId, userId))
                .orderBy(desc(assistantCompletions.completedAt))
                .limit(data.limit ?? 100)
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantCompletions error:", error);
            throw error;
        }
    });

export const createAssistantCompletion = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantCompletion, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantCompletion | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantCompletions)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantCompletion error:", error);
            throw error;
        }
    });

// ============================================
// Streaks CRUD
// ============================================

export const getAssistantStreak = createServerFn({
    method: "GET",
}).handler(async (): Promise<AssistantStreak | null> => {
    const userId = await requireUserId();

    try {
        const result = db
            .select()
            .from(assistantStreaks)
            .where(eq(assistantStreaks.userId, userId))
            .limit(1)
            .get();

        return result ?? null;
    } catch (error) {
        console.error("[Assistant] getAssistantStreak error:", error);
        throw error;
    }
});

export const upsertAssistantStreak = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantStreak, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantStreak | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantStreaks)
                .values({ ...data, userId })
                .onConflictDoUpdate({
                    target: assistantStreaks.userId,
                    set: {
                        currentStreakDays: data.currentStreakDays,
                        longestStreakDays: data.longestStreakDays,
                        lastTaskCompletionDate: data.lastTaskCompletionDate,
                        streakResetDate: data.streakResetDate,
                    },
                })
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] upsertAssistantStreak error:", error);
            throw error;
        }
    });

// ============================================
// Badges CRUD
// ============================================

export const getAssistantBadges = createServerFn({
    method: "GET",
}).handler(async (): Promise<AssistantBadge[]> => {
    const userId = await requireUserId();

    try {
        return db
            .select()
            .from(assistantBadges)
            .where(eq(assistantBadges.userId, userId))
            .orderBy(desc(assistantBadges.earnedAt))
            .all();
    } catch (error) {
        console.error("[Assistant] getAssistantBadges error:", error);
        throw error;
    }
});

export const createAssistantBadge = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantBadge, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantBadge | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantBadges)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantBadge error:", error);
            throw error;
        }
    });

// ============================================
// Communications CRUD
// ============================================

export const getAssistantCommunications = createServerFn({
    method: "GET",
})
    .inputValidator((d: { limit?: number }) => d)
    .handler(async ({ data }): Promise<AssistantCommunication[]> => {
        const userId = await requireUserId();

        try {
            const results = db
                .select()
                .from(assistantCommunications)
                .where(eq(assistantCommunications.userId, userId))
                .orderBy(desc(assistantCommunications.discussedAt))
                .limit(data.limit ?? 100)
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantCommunications error:", error);
            throw error;
        }
    });

export const createAssistantCommunication = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantCommunication, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantCommunication | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantCommunications)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantCommunication error:", error);
            throw error;
        }
    });

export const updateAssistantCommunication = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantCommunication> }) => d)
    .handler(async ({ data: input }): Promise<AssistantCommunication | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(assistantCommunications)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(
                    and(
                        eq(assistantCommunications.id, input.id),
                        eq(assistantCommunications.userId, userId)
                    )
                )
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantCommunication error:", error);
            throw error;
        }
    });

export const deleteAssistantCommunication = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();

        try {
            db.delete(assistantCommunications)
                .where(
                    and(
                        eq(assistantCommunications.id, data.id),
                        eq(assistantCommunications.userId, userId)
                    )
                )
                .run();
            return { success: true };
        } catch (error) {
            console.error("[Assistant] deleteAssistantCommunication error:", error);
            throw error;
        }
    });

// ============================================
// Decisions CRUD
// ============================================

export const getAssistantDecisions = createServerFn({
    method: "GET",
})
    .inputValidator((d: { limit?: number }) => d)
    .handler(async ({ data }): Promise<AssistantDecision[]> => {
        const userId = await requireUserId();

        try {
            const results = db
                .select()
                .from(assistantDecisions)
                .where(eq(assistantDecisions.userId, userId))
                .orderBy(desc(assistantDecisions.decidedAt))
                .limit(data.limit ?? 100)
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantDecisions error:", error);
            throw error;
        }
    });

export const createAssistantDecision = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantDecision, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantDecision | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantDecisions)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantDecision error:", error);
            throw error;
        }
    });

export const updateAssistantDecision = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantDecision> }) => d)
    .handler(async ({ data: input }): Promise<AssistantDecision | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(assistantDecisions)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(
                    and(eq(assistantDecisions.id, input.id), eq(assistantDecisions.userId, userId))
                )
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantDecision error:", error);
            throw error;
        }
    });

export const deleteAssistantDecision = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();

        try {
            db.delete(assistantDecisions)
                .where(
                    and(eq(assistantDecisions.id, data.id), eq(assistantDecisions.userId, userId))
                )
                .run();
            return { success: true };
        } catch (error) {
            console.error("[Assistant] deleteAssistantDecision error:", error);
            throw error;
        }
    });

// ============================================
// Blockers CRUD
// ============================================

export const getAssistantBlockers = createServerFn({
    method: "GET",
})
    .inputValidator((d: { activeOnly?: boolean }) => d)
    .handler(async ({ data }): Promise<AssistantBlocker[]> => {
        const userId = await requireUserId();

        try {
            const results = db
                .select()
                .from(assistantBlockers)
                .where(eq(assistantBlockers.userId, userId))
                .orderBy(desc(assistantBlockers.blockedSince))
                .all();

            if (data.activeOnly) {
                return results.filter((b) => !b.unblockedAt);
            }

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantBlockers error:", error);
            throw error;
        }
    });

export const getAssistantBlockersByTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { taskId: string }) => d)
    .handler(async ({ data }): Promise<AssistantBlocker[]> => {
        const userId = await requireUserId();

        try {
            return db
                .select()
                .from(assistantBlockers)
                .where(
                    and(
                        eq(assistantBlockers.taskId, data.taskId),
                        eq(assistantBlockers.userId, userId)
                    )
                )
                .orderBy(desc(assistantBlockers.blockedSince))
                .all();
        } catch (error) {
            console.error("[Assistant] getAssistantBlockersByTask error:", error);
            throw error;
        }
    });

export const createAssistantBlocker = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantBlocker, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantBlocker | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantBlockers)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantBlocker error:", error);
            throw error;
        }
    });

export const updateAssistantBlocker = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantBlocker> }) => d)
    .handler(async ({ data: input }): Promise<AssistantBlocker | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(assistantBlockers)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(and(eq(assistantBlockers.id, input.id), eq(assistantBlockers.userId, userId)))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantBlocker error:", error);
            throw error;
        }
    });

export const resolveAssistantBlocker = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<AssistantBlocker | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(assistantBlockers)
                .set({
                    unblockedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                })
                .where(and(eq(assistantBlockers.id, data.id), eq(assistantBlockers.userId, userId)))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] resolveAssistantBlocker error:", error);
            throw error;
        }
    });

// ============================================
// Handoffs CRUD
// ============================================

export const getAssistantHandoffs = createServerFn({
    method: "GET",
})
    .inputValidator((d: { limit?: number }) => d)
    .handler(async ({ data }): Promise<AssistantHandoff[]> => {
        const userId = await requireUserId();

        try {
            const results = db
                .select()
                .from(assistantHandoffs)
                .where(eq(assistantHandoffs.userId, userId))
                .orderBy(desc(assistantHandoffs.handoffAt))
                .limit(data.limit ?? 50)
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantHandoffs error:", error);
            throw error;
        }
    });

export const getAssistantHandoffsByTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { taskId: string }) => d)
    .handler(async ({ data }): Promise<AssistantHandoff[]> => {
        const userId = await requireUserId();

        try {
            const results = db
                .select()
                .from(assistantHandoffs)
                .where(
                    and(
                        eq(assistantHandoffs.taskId, data.taskId),
                        eq(assistantHandoffs.userId, userId)
                    )
                )
                .orderBy(desc(assistantHandoffs.handoffAt))
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantHandoffsByTask error:", error);
            throw error;
        }
    });

export const createAssistantHandoff = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantHandoff, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantHandoff | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantHandoffs)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantHandoff error:", error);
            throw error;
        }
    });

export const updateAssistantHandoff = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantHandoff> }) => d)
    .handler(async ({ data: input }): Promise<AssistantHandoff | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(assistantHandoffs)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(and(eq(assistantHandoffs.id, input.id), eq(assistantHandoffs.userId, userId)))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantHandoff error:", error);
            throw error;
        }
    });

// ============================================
// Deadline Risks CRUD
// ============================================

export const getAssistantDeadlineRisks = createServerFn({
    method: "GET",
}).handler(async (): Promise<AssistantDeadlineRisk[]> => {
    const userId = await requireUserId();

    try {
        return db
            .select()
            .from(assistantDeadlineRisks)
            .where(eq(assistantDeadlineRisks.userId, userId))
            .orderBy(desc(assistantDeadlineRisks.calculatedAt))
            .all();
    } catch (error) {
        console.error("[Assistant] getAssistantDeadlineRisks error:", error);
        throw error;
    }
});

export const getAssistantDeadlineRiskByTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { taskId: string }) => d)
    .handler(async ({ data }): Promise<AssistantDeadlineRisk | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .select()
                .from(assistantDeadlineRisks)
                .where(
                    and(
                        eq(assistantDeadlineRisks.taskId, data.taskId),
                        eq(assistantDeadlineRisks.userId, userId)
                    )
                )
                .orderBy(desc(assistantDeadlineRisks.calculatedAt))
                .limit(1)
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] getAssistantDeadlineRiskByTask error:", error);
            throw error;
        }
    });

export const createAssistantDeadlineRisk = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantDeadlineRisk, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantDeadlineRisk | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantDeadlineRisks)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantDeadlineRisk error:", error);
            throw error;
        }
    });

// ============================================
// Energy Snapshots CRUD
// ============================================

export const getAssistantEnergySnapshots = createServerFn({
    method: "GET",
})
    .inputValidator((d: { limit?: number }) => d)
    .handler(async ({ data }): Promise<AssistantEnergySnapshot[]> => {
        const userId = await requireUserId();

        try {
            return db
                .select()
                .from(assistantEnergySnapshots)
                .where(eq(assistantEnergySnapshots.userId, userId))
                .orderBy(desc(assistantEnergySnapshots.timestamp))
                .limit(data.limit ?? 168) // Default to 1 week of hourly data
                .all();
        } catch (error) {
            console.error("[Assistant] getAssistantEnergySnapshots error:", error);
            throw error;
        }
    });

export const createAssistantEnergySnapshot = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantEnergySnapshot, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantEnergySnapshot | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantEnergySnapshots)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantEnergySnapshot error:", error);
            throw error;
        }
    });

// ============================================
// Distractions CRUD
// ============================================

export const getAssistantDistractions = createServerFn({
    method: "GET",
})
    .inputValidator((d: { limit?: number }) => d)
    .handler(async ({ data }): Promise<AssistantDistraction[]> => {
        const userId = await requireUserId();

        try {
            return db
                .select()
                .from(assistantDistractions)
                .where(eq(assistantDistractions.userId, userId))
                .orderBy(desc(assistantDistractions.timestamp))
                .limit(data.limit ?? 100)
                .all();
        } catch (error) {
            console.error("[Assistant] getAssistantDistractions error:", error);
            throw error;
        }
    });

export const createAssistantDistraction = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantDistraction, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantDistraction | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantDistractions)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantDistraction error:", error);
            throw error;
        }
    });

// ============================================
// Weekly Reviews CRUD
// ============================================

export const getAssistantWeeklyReviews = createServerFn({
    method: "GET",
})
    .inputValidator((d: { limit?: number }) => d)
    .handler(async ({ data }): Promise<AssistantWeeklyReview[]> => {
        const userId = await requireUserId();

        try {
            return db
                .select()
                .from(assistantWeeklyReviews)
                .where(eq(assistantWeeklyReviews.userId, userId))
                .orderBy(desc(assistantWeeklyReviews.weekStart))
                .limit(data.limit ?? 10)
                .all();
        } catch (error) {
            console.error("[Assistant] getAssistantWeeklyReviews error:", error);
            throw error;
        }
    });

export const getAssistantCurrentWeekReview = createServerFn({
    method: "GET",
}).handler(async (): Promise<AssistantWeeklyReview | null> => {
    const userId = await requireUserId();

    try {
        // Calculate start of current week (Sunday)
        const now = new Date();
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);

        const result = db
            .select()
            .from(assistantWeeklyReviews)
            .where(
                and(
                    eq(assistantWeeklyReviews.userId, userId),
                    eq(assistantWeeklyReviews.weekStart, startOfWeek.toISOString())
                )
            )
            .limit(1)
            .get();

        return result ?? null;
    } catch (error) {
        console.error("[Assistant] getAssistantCurrentWeekReview error:", error);
        throw error;
    }
});

export const createAssistantWeeklyReview = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantWeeklyReview, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantWeeklyReview | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantWeeklyReviews)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantWeeklyReview error:", error);
            throw error;
        }
    });

// ============================================
// Celebrations CRUD
// ============================================

export const getAssistantCelebrations = createServerFn({
    method: "GET",
})
    .inputValidator((d: { unshownOnly?: boolean }) => d)
    .handler(async ({ data }): Promise<AssistantCelebration[]> => {
        const userId = await requireUserId();

        try {
            const results = db
                .select()
                .from(assistantCelebrations)
                .where(eq(assistantCelebrations.userId, userId))
                .orderBy(desc(assistantCelebrations.createdAt))
                .limit(50)
                .all();

            if (data.unshownOnly) {
                return results.filter((c) => !c.shownAt && !c.dismissed);
            }

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantCelebrations error:", error);
            throw error;
        }
    });

export const createAssistantCelebration = createServerFn({
    method: "POST",
})
    .inputValidator((d: Omit<NewAssistantCelebration, "userId">) => d)
    .handler(async ({ data }): Promise<AssistantCelebration | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .insert(assistantCelebrations)
                .values({ ...data, userId })
                .returning()
                .get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantCelebration error:", error);
            throw error;
        }
    });

export const markAssistantCelebrationShown = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<AssistantCelebration | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(assistantCelebrations)
                .set({ shownAt: new Date().toISOString() })
                .where(
                    and(
                        eq(assistantCelebrations.id, data.id),
                        eq(assistantCelebrations.userId, userId)
                    )
                )
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] markAssistantCelebrationShown error:", error);
            throw error;
        }
    });

export const dismissAssistantCelebration = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<AssistantCelebration | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(assistantCelebrations)
                .set({ dismissed: 1 })
                .where(
                    and(
                        eq(assistantCelebrations.id, data.id),
                        eq(assistantCelebrations.userId, userId)
                    )
                )
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] dismissAssistantCelebration error:", error);
            throw error;
        }
    });
