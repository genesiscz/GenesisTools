import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq } from "drizzle-orm";
import { db, type Goal, type GoalKeyResult, goalKeyResults, goals } from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";
import { emitDomainEvent } from "@/lib/events/event-bus.server";

// ============================================
// Types
// ============================================

export type GoalStatus = "active" | "done" | "archived";

/** A goal with its key results grouped in, so cards can derive progress without a second fetch. */
export type GoalRow = Goal & { keyResults: GoalKeyResult[] };

export interface CreateGoalInput {
    title: string;
    description: string;
    category: string;
    quarter: string;
    targetDate: string | null;
}

export interface UpdateGoalInput {
    id: string;
    patch: Partial<{
        title: string;
        description: string;
        category: string;
        quarter: string;
        targetDate: string | null;
        status: GoalStatus;
        progress: number;
        sortOrder: number;
    }>;
}

export interface CreateKeyResultInput {
    goalId: string;
    title: string;
    unit: string;
    startValue: number;
    targetValue: number;
}

export interface UpdateKeyResultInput {
    id: string;
    patch: Partial<{
        title: string;
        unit: string;
        startValue: number;
        targetValue: number;
        currentValue: number;
    }>;
}

// ============================================
// List
// ============================================

export const listGoals = createServerFn({ method: "GET" }).handler(async (): Promise<GoalRow[]> => {
    const userId = await requireUserId();
    try {
        const goalRows = db
            .select()
            .from(goals)
            .where(eq(goals.userId, userId))
            .orderBy(asc(goals.sortOrder), asc(goals.createdAt))
            .all();

        const krRows = db
            .select()
            .from(goalKeyResults)
            .where(eq(goalKeyResults.userId, userId))
            .orderBy(asc(goalKeyResults.createdAt))
            .all();

        const krByGoal = new Map<string, GoalKeyResult[]>();
        for (const kr of krRows) {
            const list = krByGoal.get(kr.goalId);
            if (list) {
                list.push(kr);
            } else {
                krByGoal.set(kr.goalId, [kr]);
            }
        }

        return goalRows.map((g) => ({ ...g, keyResults: krByGoal.get(g.id) ?? [] }));
    } catch (err) {
        console.error("[goals] listGoals failed:", err);
        throw err;
    }
});

// ============================================
// Create goal
// ============================================

export const createGoal = createServerFn({ method: "POST" })
    .inputValidator((d: CreateGoalInput) => d)
    .handler(async ({ data }): Promise<GoalRow> => {
        const userId = await requireUserId();
        try {
            const now = new Date().toISOString();
            const id = crypto.randomUUID();
            db.insert(goals)
                .values({
                    id,
                    userId,
                    title: data.title,
                    description: data.description,
                    category: data.category,
                    quarter: data.quarter,
                    targetDate: data.targetDate,
                    status: "active",
                    progress: 0,
                    sortOrder: 0,
                    createdAt: now,
                    updatedAt: now,
                    metadataJson: "{}",
                })
                .run();

            const created = db.select().from(goals).where(eq(goals.id, id)).get();
            if (!created) {
                throw new Error("[goals] createGoal: goal not found after insert");
            }

            emitDomainEvent(userId, "goals", { type: "created" });

            return { ...created, keyResults: [] };
        } catch (err) {
            console.error("[goals] createGoal failed:", err);
            throw err;
        }
    });

// ============================================
// Update goal (also handles status + manual progress)
// ============================================

export const updateGoal = createServerFn({ method: "POST" })
    .inputValidator((d: UpdateGoalInput) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();
        try {
            const now = new Date().toISOString();
            db.update(goals)
                .set({ ...data.patch, updatedAt: now })
                .where(and(eq(goals.id, data.id), eq(goals.userId, userId)))
                .run();

            emitDomainEvent(userId, "goals", { type: "updated" });

            return { success: true };
        } catch (err) {
            console.error("[goals] updateGoal failed:", err);
            throw err;
        }
    });

// ============================================
// Delete goal (cascade its key results)
// ============================================

export const deleteGoal = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();
        try {
            db.delete(goalKeyResults)
                .where(and(eq(goalKeyResults.goalId, data.id), eq(goalKeyResults.userId, userId)))
                .run();
            db.delete(goals)
                .where(and(eq(goals.id, data.id), eq(goals.userId, userId)))
                .run();

            emitDomainEvent(userId, "goals", { type: "deleted" });

            return { success: true };
        } catch (err) {
            console.error("[goals] deleteGoal failed:", err);
            throw err;
        }
    });

// ============================================
// Create key result
// ============================================

export const createKeyResult = createServerFn({ method: "POST" })
    .inputValidator((d: CreateKeyResultInput) => d)
    .handler(async ({ data }): Promise<GoalKeyResult> => {
        const userId = await requireUserId();
        try {
            const now = new Date().toISOString();
            const id = crypto.randomUUID();
            db.insert(goalKeyResults)
                .values({
                    id,
                    userId,
                    goalId: data.goalId,
                    title: data.title,
                    unit: data.unit,
                    startValue: data.startValue,
                    targetValue: data.targetValue,
                    currentValue: data.startValue,
                    createdAt: now,
                    updatedAt: now,
                    metadataJson: "{}",
                })
                .run();

            const created = db.select().from(goalKeyResults).where(eq(goalKeyResults.id, id)).get();
            if (!created) {
                throw new Error("[goals] createKeyResult: key result not found after insert");
            }

            emitDomainEvent(userId, "goals", { type: "updated" });

            return created;
        } catch (err) {
            console.error("[goals] createKeyResult failed:", err);
            throw err;
        }
    });

// ============================================
// Update key result (inline currentValue edits)
// ============================================

export const updateKeyResult = createServerFn({ method: "POST" })
    .inputValidator((d: UpdateKeyResultInput) => d)
    .handler(async ({ data }): Promise<GoalKeyResult> => {
        const userId = await requireUserId();
        try {
            const now = new Date().toISOString();
            db.update(goalKeyResults)
                .set({ ...data.patch, updatedAt: now })
                .where(and(eq(goalKeyResults.id, data.id), eq(goalKeyResults.userId, userId)))
                .run();

            const updated = db.select().from(goalKeyResults).where(eq(goalKeyResults.id, data.id)).get();
            if (!updated) {
                throw new Error(`[goals] updateKeyResult: key result ${data.id} not found after update`);
            }

            emitDomainEvent(userId, "goals", { type: "updated" });

            return updated;
        } catch (err) {
            console.error("[goals] updateKeyResult failed:", err);
            throw err;
        }
    });

// ============================================
// Delete key result
// ============================================

export const deleteKeyResult = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();
        try {
            db.delete(goalKeyResults)
                .where(and(eq(goalKeyResults.id, data.id), eq(goalKeyResults.userId, userId)))
                .run();

            emitDomainEvent(userId, "goals", { type: "updated" });

            return { success: true };
        } catch (err) {
            console.error("[goals] deleteKeyResult failed:", err);
            throw err;
        }
    });
