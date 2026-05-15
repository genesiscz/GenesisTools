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
})
    .inputValidator((d: { userId: string }) => d)
    .handler(({ data }): AssistantTask[] => {
        try {
            const results = db
                .select()
                .from(assistantTasks)
                .where(eq(assistantTasks.userId, data.userId))
                .orderBy(desc(assistantTasks.updatedAt))
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantTasks error:", error);
            return [];
        }
    });

export const getAssistantTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { id: string }) => d)
    .handler(({ data }): AssistantTask | null => {
        try {
            const result = db.select().from(assistantTasks).where(eq(assistantTasks.id, data.id)).get();

            if (!result) {
                return null;
            }

            return {
                ...result,
            };
        } catch (error) {
            console.error("[Assistant] getAssistantTask error:", error);
            return null;
        }
    });

export const createAssistantTask = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantTask) => d)
    .handler(({ data }): AssistantTask | null => {
        try {
            const result = db.insert(assistantTasks).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantTask error:", error);
            return null;
        }
    });

export const updateAssistantTask = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantTask> }) => d)
    .handler(({ data: input }): AssistantTask | null => {
        try {
            const result = db
                .update(assistantTasks)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantTasks.id, input.id))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantTask error:", error);
            return null;
        }
    });

export const deleteAssistantTask = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(({ data }): { success: boolean } => {
        try {
            db.delete(assistantTasks).where(eq(assistantTasks.id, data.id)).run();
            return { success: true };
        } catch (error) {
            console.error("[Assistant] deleteAssistantTask error:", error);
            return { success: false };
        }
    });

// ============================================
// Context Parking CRUD
// ============================================

export const getAssistantContextParkings = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string }) => d)
    .handler(({ data }): AssistantContextParking[] => {
        try {
            const results = db
                .select()
                .from(assistantContextParking)
                .where(eq(assistantContextParking.userId, data.userId))
                .orderBy(desc(assistantContextParking.parkedAt))
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantContextParkings error:", error);
            return [];
        }
    });

export const createAssistantContextParking = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantContextParking) => d)
    .handler(({ data }): AssistantContextParking | null => {
        try {
            const result = db.insert(assistantContextParking).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantContextParking error:", error);
            return null;
        }
    });

export const updateAssistantContextParking = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantContextParking> }) => d)
    .handler(({ data: input }): AssistantContextParking | null => {
        try {
            const result = db
                .update(assistantContextParking)
                .set(input.data)
                .where(eq(assistantContextParking.id, input.id))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantContextParking error:", error);
            return null;
        }
    });

// ============================================
// Completions CRUD
// ============================================

export const getAssistantCompletions = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string; limit?: number }) => d)
    .handler(({ data }): AssistantCompletion[] => {
        try {
            const results = db
                .select()
                .from(assistantCompletions)
                .where(eq(assistantCompletions.userId, data.userId))
                .orderBy(desc(assistantCompletions.completedAt))
                .limit(data.limit ?? 100)
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantCompletions error:", error);
            return [];
        }
    });

export const createAssistantCompletion = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantCompletion) => d)
    .handler(({ data }): AssistantCompletion | null => {
        try {
            const result = db.insert(assistantCompletions).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantCompletion error:", error);
            return null;
        }
    });

// ============================================
// Streaks CRUD
// ============================================

export const getAssistantStreak = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string }) => d)
    .handler(({ data }): AssistantStreak | null => {
        try {
            const result = db
                .select()
                .from(assistantStreaks)
                .where(eq(assistantStreaks.userId, data.userId))
                .limit(1)
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] getAssistantStreak error:", error);
            return null;
        }
    });

export const upsertAssistantStreak = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantStreak) => d)
    .handler(({ data }): AssistantStreak | null => {
        try {
            const result = db
                .insert(assistantStreaks)
                .values(data)
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
            return null;
        }
    });

// ============================================
// Badges CRUD
// ============================================

export const getAssistantBadges = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string }) => d)
    .handler(({ data }): AssistantBadge[] => {
        try {
            return db
                .select()
                .from(assistantBadges)
                .where(eq(assistantBadges.userId, data.userId))
                .orderBy(desc(assistantBadges.earnedAt))
                .all();
        } catch (error) {
            console.error("[Assistant] getAssistantBadges error:", error);
            return [];
        }
    });

export const createAssistantBadge = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantBadge) => d)
    .handler(({ data }): AssistantBadge | null => {
        try {
            const result = db.insert(assistantBadges).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantBadge error:", error);
            return null;
        }
    });

// ============================================
// Communications CRUD
// ============================================

export const getAssistantCommunications = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string; limit?: number }) => d)
    .handler(({ data }): AssistantCommunication[] => {
        try {
            const results = db
                .select()
                .from(assistantCommunications)
                .where(eq(assistantCommunications.userId, data.userId))
                .orderBy(desc(assistantCommunications.discussedAt))
                .limit(data.limit ?? 100)
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantCommunications error:", error);
            return [];
        }
    });

export const createAssistantCommunication = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantCommunication) => d)
    .handler(({ data }): AssistantCommunication | null => {
        try {
            const result = db.insert(assistantCommunications).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantCommunication error:", error);
            return null;
        }
    });

export const updateAssistantCommunication = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantCommunication> }) => d)
    .handler(({ data: input }): AssistantCommunication | null => {
        try {
            const result = db
                .update(assistantCommunications)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantCommunications.id, input.id))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantCommunication error:", error);
            return null;
        }
    });

export const deleteAssistantCommunication = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(({ data }): { success: boolean } => {
        try {
            db.delete(assistantCommunications).where(eq(assistantCommunications.id, data.id)).run();
            return { success: true };
        } catch (error) {
            console.error("[Assistant] deleteAssistantCommunication error:", error);
            return { success: false };
        }
    });

// ============================================
// Decisions CRUD
// ============================================

export const getAssistantDecisions = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string; limit?: number }) => d)
    .handler(({ data }): AssistantDecision[] => {
        try {
            const results = db
                .select()
                .from(assistantDecisions)
                .where(eq(assistantDecisions.userId, data.userId))
                .orderBy(desc(assistantDecisions.decidedAt))
                .limit(data.limit ?? 100)
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantDecisions error:", error);
            return [];
        }
    });

export const createAssistantDecision = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantDecision) => d)
    .handler(({ data }): AssistantDecision | null => {
        try {
            const result = db.insert(assistantDecisions).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantDecision error:", error);
            return null;
        }
    });

export const updateAssistantDecision = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantDecision> }) => d)
    .handler(({ data: input }): AssistantDecision | null => {
        try {
            const result = db
                .update(assistantDecisions)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantDecisions.id, input.id))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantDecision error:", error);
            return null;
        }
    });

export const deleteAssistantDecision = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(({ data }): { success: boolean } => {
        try {
            db.delete(assistantDecisions).where(eq(assistantDecisions.id, data.id)).run();
            return { success: true };
        } catch (error) {
            console.error("[Assistant] deleteAssistantDecision error:", error);
            return { success: false };
        }
    });

// ============================================
// Blockers CRUD
// ============================================

export const getAssistantBlockers = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string; activeOnly?: boolean }) => d)
    .handler(({ data }): AssistantBlocker[] => {
        try {
            const results = db
                .select()
                .from(assistantBlockers)
                .where(eq(assistantBlockers.userId, data.userId))
                .orderBy(desc(assistantBlockers.blockedSince))
                .all();

            if (data.activeOnly) {
                return results.filter((b) => !b.unblockedAt);
            }

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantBlockers error:", error);
            return [];
        }
    });

export const getAssistantBlockersByTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { taskId: string }) => d)
    .handler(({ data }): AssistantBlocker[] => {
        try {
            return db
                .select()
                .from(assistantBlockers)
                .where(eq(assistantBlockers.taskId, data.taskId))
                .orderBy(desc(assistantBlockers.blockedSince))
                .all();
        } catch (error) {
            console.error("[Assistant] getAssistantBlockersByTask error:", error);
            return [];
        }
    });

export const createAssistantBlocker = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantBlocker) => d)
    .handler(({ data }): AssistantBlocker | null => {
        try {
            const result = db.insert(assistantBlockers).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantBlocker error:", error);
            return null;
        }
    });

export const updateAssistantBlocker = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantBlocker> }) => d)
    .handler(({ data: input }): AssistantBlocker | null => {
        try {
            const result = db
                .update(assistantBlockers)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantBlockers.id, input.id))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantBlocker error:", error);
            return null;
        }
    });

export const resolveAssistantBlocker = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(({ data }): AssistantBlocker | null => {
        try {
            const result = db
                .update(assistantBlockers)
                .set({
                    unblockedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantBlockers.id, data.id))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] resolveAssistantBlocker error:", error);
            return null;
        }
    });

// ============================================
// Handoffs CRUD
// ============================================

export const getAssistantHandoffs = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string; limit?: number }) => d)
    .handler(({ data }): AssistantHandoff[] => {
        try {
            const results = db
                .select()
                .from(assistantHandoffs)
                .where(eq(assistantHandoffs.userId, data.userId))
                .orderBy(desc(assistantHandoffs.handoffAt))
                .limit(data.limit ?? 50)
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantHandoffs error:", error);
            return [];
        }
    });

export const getAssistantHandoffsByTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { taskId: string }) => d)
    .handler(({ data }): AssistantHandoff[] => {
        try {
            const results = db
                .select()
                .from(assistantHandoffs)
                .where(eq(assistantHandoffs.taskId, data.taskId))
                .orderBy(desc(assistantHandoffs.handoffAt))
                .all();

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantHandoffsByTask error:", error);
            return [];
        }
    });

export const createAssistantHandoff = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantHandoff) => d)
    .handler(({ data }): AssistantHandoff | null => {
        try {
            const result = db.insert(assistantHandoffs).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantHandoff error:", error);
            return null;
        }
    });

export const updateAssistantHandoff = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string; data: Partial<NewAssistantHandoff> }) => d)
    .handler(({ data: input }): AssistantHandoff | null => {
        try {
            const result = db
                .update(assistantHandoffs)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantHandoffs.id, input.id))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] updateAssistantHandoff error:", error);
            return null;
        }
    });

// ============================================
// Deadline Risks CRUD
// ============================================

export const getAssistantDeadlineRisks = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string }) => d)
    .handler(({ data }): AssistantDeadlineRisk[] => {
        try {
            return db
                .select()
                .from(assistantDeadlineRisks)
                .where(eq(assistantDeadlineRisks.userId, data.userId))
                .orderBy(desc(assistantDeadlineRisks.calculatedAt))
                .all();
        } catch (error) {
            console.error("[Assistant] getAssistantDeadlineRisks error:", error);
            return [];
        }
    });

export const getAssistantDeadlineRiskByTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { taskId: string }) => d)
    .handler(({ data }): AssistantDeadlineRisk | null => {
        try {
            const result = db
                .select()
                .from(assistantDeadlineRisks)
                .where(eq(assistantDeadlineRisks.taskId, data.taskId))
                .orderBy(desc(assistantDeadlineRisks.calculatedAt))
                .limit(1)
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] getAssistantDeadlineRiskByTask error:", error);
            return null;
        }
    });

export const createAssistantDeadlineRisk = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantDeadlineRisk) => d)
    .handler(({ data }): AssistantDeadlineRisk | null => {
        try {
            const result = db.insert(assistantDeadlineRisks).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantDeadlineRisk error:", error);
            return null;
        }
    });

// ============================================
// Energy Snapshots CRUD
// ============================================

export const getAssistantEnergySnapshots = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string; limit?: number }) => d)
    .handler(({ data }): AssistantEnergySnapshot[] => {
        try {
            return db
                .select()
                .from(assistantEnergySnapshots)
                .where(eq(assistantEnergySnapshots.userId, data.userId))
                .orderBy(desc(assistantEnergySnapshots.timestamp))
                .limit(data.limit ?? 168) // Default to 1 week of hourly data
                .all();
        } catch (error) {
            console.error("[Assistant] getAssistantEnergySnapshots error:", error);
            return [];
        }
    });

export const createAssistantEnergySnapshot = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantEnergySnapshot) => d)
    .handler(({ data }): AssistantEnergySnapshot | null => {
        try {
            const result = db.insert(assistantEnergySnapshots).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantEnergySnapshot error:", error);
            return null;
        }
    });

// ============================================
// Distractions CRUD
// ============================================

export const getAssistantDistractions = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string; limit?: number }) => d)
    .handler(({ data }): AssistantDistraction[] => {
        try {
            return db
                .select()
                .from(assistantDistractions)
                .where(eq(assistantDistractions.userId, data.userId))
                .orderBy(desc(assistantDistractions.timestamp))
                .limit(data.limit ?? 100)
                .all();
        } catch (error) {
            console.error("[Assistant] getAssistantDistractions error:", error);
            return [];
        }
    });

export const createAssistantDistraction = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantDistraction) => d)
    .handler(({ data }): AssistantDistraction | null => {
        try {
            const result = db.insert(assistantDistractions).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantDistraction error:", error);
            return null;
        }
    });

// ============================================
// Weekly Reviews CRUD
// ============================================

export const getAssistantWeeklyReviews = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string; limit?: number }) => d)
    .handler(({ data }): AssistantWeeklyReview[] => {
        try {
            return db
                .select()
                .from(assistantWeeklyReviews)
                .where(eq(assistantWeeklyReviews.userId, data.userId))
                .orderBy(desc(assistantWeeklyReviews.weekStart))
                .limit(data.limit ?? 10)
                .all();
        } catch (error) {
            console.error("[Assistant] getAssistantWeeklyReviews error:", error);
            return [];
        }
    });

export const getAssistantCurrentWeekReview = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string }) => d)
    .handler(({ data }): AssistantWeeklyReview | null => {
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
                        eq(assistantWeeklyReviews.userId, data.userId),
                        eq(assistantWeeklyReviews.weekStart, startOfWeek.toISOString())
                    )
                )
                .limit(1)
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] getAssistantCurrentWeekReview error:", error);
            return null;
        }
    });

export const createAssistantWeeklyReview = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantWeeklyReview) => d)
    .handler(({ data }): AssistantWeeklyReview | null => {
        try {
            const result = db.insert(assistantWeeklyReviews).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantWeeklyReview error:", error);
            return null;
        }
    });

// ============================================
// Celebrations CRUD
// ============================================

export const getAssistantCelebrations = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string; unshownOnly?: boolean }) => d)
    .handler(({ data }): AssistantCelebration[] => {
        try {
            const results = db
                .select()
                .from(assistantCelebrations)
                .where(eq(assistantCelebrations.userId, data.userId))
                .orderBy(desc(assistantCelebrations.createdAt))
                .limit(50)
                .all();

            if (data.unshownOnly) {
                return results.filter((c) => !c.shownAt && !c.dismissed);
            }

            return results;
        } catch (error) {
            console.error("[Assistant] getAssistantCelebrations error:", error);
            return [];
        }
    });

export const createAssistantCelebration = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantCelebration) => d)
    .handler(({ data }): AssistantCelebration | null => {
        try {
            const result = db.insert(assistantCelebrations).values(data).returning().get();
            return result ?? null;
        } catch (error) {
            console.error("[Assistant] createAssistantCelebration error:", error);
            return null;
        }
    });

export const markAssistantCelebrationShown = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(({ data }): AssistantCelebration | null => {
        try {
            const result = db
                .update(assistantCelebrations)
                .set({ shownAt: new Date().toISOString() })
                .where(eq(assistantCelebrations.id, data.id))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] markAssistantCelebrationShown error:", error);
            return null;
        }
    });

export const dismissAssistantCelebration = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(({ data }): AssistantCelebration | null => {
        try {
            const result = db
                .update(assistantCelebrations)
                .set({ dismissed: 1 })
                .where(eq(assistantCelebrations.id, data.id))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] dismissAssistantCelebration error:", error);
            return null;
        }
    });
