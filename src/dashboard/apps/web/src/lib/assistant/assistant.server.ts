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
// Helper: Parse JSONB fields from neon-http
// ============================================

function parseJsonbField<T>(value: unknown, fallback: T): T {
    if (value === null || value === undefined) {
        return fallback;
    }
    if (typeof value === "string") {
        try {
            return JSON.parse(value) as T;
        } catch {
            return fallback;
        }
    }
    return value as T;
}

// ============================================
// Tasks CRUD
// ============================================

export const getAssistantTasks = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string }) => d)
    .handler(async ({ data }): Promise<AssistantTask[]> => {
        try {
            const results = await db
                .select()
                .from(assistantTasks)
                .where(eq(assistantTasks.userId, data.userId))
                .orderBy(desc(assistantTasks.updatedAt));

            return results.map((task) => ({
                ...task,
                blockedBy: parseJsonbField<string[]>(task.blockedBy, []),
                blocks: parseJsonbField<string[]>(task.blocks, []),
            }));
        } catch (error) {
            console.error("[Assistant] getAssistantTasks error:", error);
            return [];
        }
    });

export const getAssistantTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<AssistantTask | null> => {
        try {
            const [result] = await db.select().from(assistantTasks).where(eq(assistantTasks.id, data.id)).limit(1);

            if (!result) {
                return null;
            }

            return {
                ...result,
                blockedBy: parseJsonbField<string[]>(result.blockedBy, []),
                blocks: parseJsonbField<string[]>(result.blocks, []),
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
    .handler(async ({ data }): Promise<AssistantTask | null> => {
        try {
            const [result] = await db.insert(assistantTasks).values(data).returning();
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
    .handler(async ({ data: input }): Promise<AssistantTask | null> => {
        try {
            const [result] = await db
                .update(assistantTasks)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantTasks.id, input.id))
                .returning();

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
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        try {
            await db.delete(assistantTasks).where(eq(assistantTasks.id, data.id));
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
    .handler(async ({ data }): Promise<AssistantContextParking[]> => {
        try {
            const results = await db
                .select()
                .from(assistantContextParking)
                .where(eq(assistantContextParking.userId, data.userId))
                .orderBy(desc(assistantContextParking.parkedAt));

            return results.map((item) => ({
                ...item,
                codeContext: parseJsonbField(item.codeContext, undefined),
            }));
        } catch (error) {
            console.error("[Assistant] getAssistantContextParkings error:", error);
            return [];
        }
    });

export const createAssistantContextParking = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantContextParking) => d)
    .handler(async ({ data }): Promise<AssistantContextParking | null> => {
        try {
            const [result] = await db.insert(assistantContextParking).values(data).returning();
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
    .handler(async ({ data: input }): Promise<AssistantContextParking | null> => {
        try {
            const [result] = await db
                .update(assistantContextParking)
                .set(input.data)
                .where(eq(assistantContextParking.id, input.id))
                .returning();

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
    .handler(async ({ data }): Promise<AssistantCompletion[]> => {
        try {
            const results = await db
                .select()
                .from(assistantCompletions)
                .where(eq(assistantCompletions.userId, data.userId))
                .orderBy(desc(assistantCompletions.completedAt))
                .limit(data.limit ?? 100);

            return results.map((item) => ({
                ...item,
                metadata: parseJsonbField(item.metadata, {}),
            }));
        } catch (error) {
            console.error("[Assistant] getAssistantCompletions error:", error);
            return [];
        }
    });

export const createAssistantCompletion = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantCompletion) => d)
    .handler(async ({ data }): Promise<AssistantCompletion | null> => {
        try {
            const [result] = await db.insert(assistantCompletions).values(data).returning();
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
    .handler(async ({ data }): Promise<AssistantStreak | null> => {
        try {
            const [result] = await db
                .select()
                .from(assistantStreaks)
                .where(eq(assistantStreaks.userId, data.userId))
                .limit(1);

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
    .handler(async ({ data }): Promise<AssistantStreak | null> => {
        try {
            const [result] = await db
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
                .returning();

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
    .handler(async ({ data }): Promise<AssistantBadge[]> => {
        try {
            return await db
                .select()
                .from(assistantBadges)
                .where(eq(assistantBadges.userId, data.userId))
                .orderBy(desc(assistantBadges.earnedAt));
        } catch (error) {
            console.error("[Assistant] getAssistantBadges error:", error);
            return [];
        }
    });

export const createAssistantBadge = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantBadge) => d)
    .handler(async ({ data }): Promise<AssistantBadge | null> => {
        try {
            const [result] = await db.insert(assistantBadges).values(data).returning();
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
    .handler(async ({ data }): Promise<AssistantCommunication[]> => {
        try {
            const results = await db
                .select()
                .from(assistantCommunications)
                .where(eq(assistantCommunications.userId, data.userId))
                .orderBy(desc(assistantCommunications.discussedAt))
                .limit(data.limit ?? 100);

            return results.map((item) => ({
                ...item,
                tags: parseJsonbField<string[]>(item.tags, []),
                relatedTaskIds: parseJsonbField<string[]>(item.relatedTaskIds, []),
            }));
        } catch (error) {
            console.error("[Assistant] getAssistantCommunications error:", error);
            return [];
        }
    });

export const createAssistantCommunication = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantCommunication) => d)
    .handler(async ({ data }): Promise<AssistantCommunication | null> => {
        try {
            const [result] = await db.insert(assistantCommunications).values(data).returning();
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
    .handler(async ({ data: input }): Promise<AssistantCommunication | null> => {
        try {
            const [result] = await db
                .update(assistantCommunications)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantCommunications.id, input.id))
                .returning();

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
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        try {
            await db.delete(assistantCommunications).where(eq(assistantCommunications.id, data.id));
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
    .handler(async ({ data }): Promise<AssistantDecision[]> => {
        try {
            const results = await db
                .select()
                .from(assistantDecisions)
                .where(eq(assistantDecisions.userId, data.userId))
                .orderBy(desc(assistantDecisions.decidedAt))
                .limit(data.limit ?? 100);

            return results.map((item) => ({
                ...item,
                alternativesConsidered: parseJsonbField<string[]>(item.alternativesConsidered, []),
                relatedTaskIds: parseJsonbField<string[]>(item.relatedTaskIds, []),
                tags: parseJsonbField<string[]>(item.tags, []),
            }));
        } catch (error) {
            console.error("[Assistant] getAssistantDecisions error:", error);
            return [];
        }
    });

export const createAssistantDecision = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantDecision) => d)
    .handler(async ({ data }): Promise<AssistantDecision | null> => {
        try {
            const [result] = await db.insert(assistantDecisions).values(data).returning();
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
    .handler(async ({ data: input }): Promise<AssistantDecision | null> => {
        try {
            const [result] = await db
                .update(assistantDecisions)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantDecisions.id, input.id))
                .returning();

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
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        try {
            await db.delete(assistantDecisions).where(eq(assistantDecisions.id, data.id));
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
    .handler(async ({ data }): Promise<AssistantBlocker[]> => {
        try {
            const query = db
                .select()
                .from(assistantBlockers)
                .where(eq(assistantBlockers.userId, data.userId))
                .orderBy(desc(assistantBlockers.blockedSince));

            const results = await query;

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
    .handler(async ({ data }): Promise<AssistantBlocker[]> => {
        try {
            return await db
                .select()
                .from(assistantBlockers)
                .where(eq(assistantBlockers.taskId, data.taskId))
                .orderBy(desc(assistantBlockers.blockedSince));
        } catch (error) {
            console.error("[Assistant] getAssistantBlockersByTask error:", error);
            return [];
        }
    });

export const createAssistantBlocker = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantBlocker) => d)
    .handler(async ({ data }): Promise<AssistantBlocker | null> => {
        try {
            const [result] = await db.insert(assistantBlockers).values(data).returning();
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
    .handler(async ({ data: input }): Promise<AssistantBlocker | null> => {
        try {
            const [result] = await db
                .update(assistantBlockers)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantBlockers.id, input.id))
                .returning();

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
    .handler(async ({ data }): Promise<AssistantBlocker | null> => {
        try {
            const [result] = await db
                .update(assistantBlockers)
                .set({
                    unblockedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantBlockers.id, data.id))
                .returning();

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
    .handler(async ({ data }): Promise<AssistantHandoff[]> => {
        try {
            const results = await db
                .select()
                .from(assistantHandoffs)
                .where(eq(assistantHandoffs.userId, data.userId))
                .orderBy(desc(assistantHandoffs.handoffAt))
                .limit(data.limit ?? 50);

            return results.map((item) => ({
                ...item,
                decisions: parseJsonbField<string[]>(item.decisions, []),
                blockers: parseJsonbField<string[]>(item.blockers, []),
                nextSteps: parseJsonbField<string[]>(item.nextSteps, []),
            }));
        } catch (error) {
            console.error("[Assistant] getAssistantHandoffs error:", error);
            return [];
        }
    });

export const getAssistantHandoffsByTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { taskId: string }) => d)
    .handler(async ({ data }): Promise<AssistantHandoff[]> => {
        try {
            const results = await db
                .select()
                .from(assistantHandoffs)
                .where(eq(assistantHandoffs.taskId, data.taskId))
                .orderBy(desc(assistantHandoffs.handoffAt));

            return results.map((item) => ({
                ...item,
                decisions: parseJsonbField<string[]>(item.decisions, []),
                blockers: parseJsonbField<string[]>(item.blockers, []),
                nextSteps: parseJsonbField<string[]>(item.nextSteps, []),
            }));
        } catch (error) {
            console.error("[Assistant] getAssistantHandoffsByTask error:", error);
            return [];
        }
    });

export const createAssistantHandoff = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantHandoff) => d)
    .handler(async ({ data }): Promise<AssistantHandoff | null> => {
        try {
            const [result] = await db.insert(assistantHandoffs).values(data).returning();
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
    .handler(async ({ data: input }): Promise<AssistantHandoff | null> => {
        try {
            const [result] = await db
                .update(assistantHandoffs)
                .set({
                    ...input.data,
                    updatedAt: new Date().toISOString(),
                })
                .where(eq(assistantHandoffs.id, input.id))
                .returning();

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
    .handler(async ({ data }): Promise<AssistantDeadlineRisk[]> => {
        try {
            return await db
                .select()
                .from(assistantDeadlineRisks)
                .where(eq(assistantDeadlineRisks.userId, data.userId))
                .orderBy(desc(assistantDeadlineRisks.calculatedAt));
        } catch (error) {
            console.error("[Assistant] getAssistantDeadlineRisks error:", error);
            return [];
        }
    });

export const getAssistantDeadlineRiskByTask = createServerFn({
    method: "GET",
})
    .inputValidator((d: { taskId: string }) => d)
    .handler(async ({ data }): Promise<AssistantDeadlineRisk | null> => {
        try {
            const [result] = await db
                .select()
                .from(assistantDeadlineRisks)
                .where(eq(assistantDeadlineRisks.taskId, data.taskId))
                .orderBy(desc(assistantDeadlineRisks.calculatedAt))
                .limit(1);

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
    .handler(async ({ data }): Promise<AssistantDeadlineRisk | null> => {
        try {
            const [result] = await db.insert(assistantDeadlineRisks).values(data).returning();
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
    .handler(async ({ data }): Promise<AssistantEnergySnapshot[]> => {
        try {
            return await db
                .select()
                .from(assistantEnergySnapshots)
                .where(eq(assistantEnergySnapshots.userId, data.userId))
                .orderBy(desc(assistantEnergySnapshots.timestamp))
                .limit(data.limit ?? 168); // Default to 1 week of hourly data
        } catch (error) {
            console.error("[Assistant] getAssistantEnergySnapshots error:", error);
            return [];
        }
    });

export const createAssistantEnergySnapshot = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantEnergySnapshot) => d)
    .handler(async ({ data }): Promise<AssistantEnergySnapshot | null> => {
        try {
            const [result] = await db.insert(assistantEnergySnapshots).values(data).returning();
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
    .handler(async ({ data }): Promise<AssistantDistraction[]> => {
        try {
            return await db
                .select()
                .from(assistantDistractions)
                .where(eq(assistantDistractions.userId, data.userId))
                .orderBy(desc(assistantDistractions.timestamp))
                .limit(data.limit ?? 100);
        } catch (error) {
            console.error("[Assistant] getAssistantDistractions error:", error);
            return [];
        }
    });

export const createAssistantDistraction = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantDistraction) => d)
    .handler(async ({ data }): Promise<AssistantDistraction | null> => {
        try {
            const [result] = await db.insert(assistantDistractions).values(data).returning();
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
    .handler(async ({ data }): Promise<AssistantWeeklyReview[]> => {
        try {
            const results = await db
                .select()
                .from(assistantWeeklyReviews)
                .where(eq(assistantWeeklyReviews.userId, data.userId))
                .orderBy(desc(assistantWeeklyReviews.weekStart))
                .limit(data.limit ?? 10);

            return results.map((item) => ({
                ...item,
                energyByDay: parseJsonbField<Record<string, number>>(item.energyByDay, {}),
                insights: parseJsonbField<string[]>(item.insights, []),
                recommendations: parseJsonbField<string[]>(item.recommendations, []),
                badgesEarned: parseJsonbField<string[]>(item.badgesEarned, []),
            }));
        } catch (error) {
            console.error("[Assistant] getAssistantWeeklyReviews error:", error);
            return [];
        }
    });

export const getAssistantCurrentWeekReview = createServerFn({
    method: "GET",
})
    .inputValidator((d: { userId: string }) => d)
    .handler(async ({ data }): Promise<AssistantWeeklyReview | null> => {
        try {
            // Calculate start of current week (Sunday)
            const now = new Date();
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - now.getDay());
            startOfWeek.setHours(0, 0, 0, 0);

            const results = await db
                .select()
                .from(assistantWeeklyReviews)
                .where(
                    and(
                        eq(assistantWeeklyReviews.userId, data.userId),
                        eq(assistantWeeklyReviews.weekStart, startOfWeek.toISOString())
                    )
                )
                .limit(1);

            if (results.length === 0) {
                return null;
            }

            const item = results[0];
            return {
                ...item,
                energyByDay: parseJsonbField<Record<string, number>>(item.energyByDay, {}),
                insights: parseJsonbField<string[]>(item.insights, []),
                recommendations: parseJsonbField<string[]>(item.recommendations, []),
                badgesEarned: parseJsonbField<string[]>(item.badgesEarned, []),
            };
        } catch (error) {
            console.error("[Assistant] getAssistantCurrentWeekReview error:", error);
            return null;
        }
    });

export const createAssistantWeeklyReview = createServerFn({
    method: "POST",
})
    .inputValidator((d: NewAssistantWeeklyReview) => d)
    .handler(async ({ data }): Promise<AssistantWeeklyReview | null> => {
        try {
            const [result] = await db.insert(assistantWeeklyReviews).values(data).returning();
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
    .handler(async ({ data }): Promise<AssistantCelebration[]> => {
        try {
            const results = await db
                .select()
                .from(assistantCelebrations)
                .where(eq(assistantCelebrations.userId, data.userId))
                .orderBy(desc(assistantCelebrations.createdAt))
                .limit(50);

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
    .handler(async ({ data }): Promise<AssistantCelebration | null> => {
        try {
            const [result] = await db.insert(assistantCelebrations).values(data).returning();
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
    .handler(async ({ data }): Promise<AssistantCelebration | null> => {
        try {
            const [result] = await db
                .update(assistantCelebrations)
                .set({ shownAt: new Date().toISOString() })
                .where(eq(assistantCelebrations.id, data.id))
                .returning();

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
    .handler(async ({ data }): Promise<AssistantCelebration | null> => {
        try {
            const [result] = await db
                .update(assistantCelebrations)
                .set({ dismissed: 1 })
                .where(eq(assistantCelebrations.id, data.id))
                .returning();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] dismissAssistantCelebration error:", error);
            return null;
        }
    });
