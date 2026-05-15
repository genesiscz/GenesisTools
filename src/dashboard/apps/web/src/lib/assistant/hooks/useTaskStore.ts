/**
 * Task Store Hook - Server-first via TanStack Query
 *
 * Uses TanStack Query for server data with refetchOnWindowFocus.
 * No localStorage fallback — SQLite is the source of truth.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import { useMemo } from "react";
import type {
    Badge,
    CompletionEvent,
    ContextParking,
    ContextParkingInput,
    Streak,
    Task,
    TaskInput,
    TaskUpdate,
} from "@/lib/assistant/types";
import { BADGE_DEFINITIONS, generateBadgeId, generateCompletionId, generateTaskId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantBadgesQuery,
    useAssistantContextParkingsQuery,
    useAssistantStreakQuery,
    useAssistantTasksQuery,
    useCreateAssistantBadgeMutation,
    useCreateAssistantCompletionMutation,
    useCreateAssistantContextParkingMutation,
    useCreateAssistantTaskMutation,
    useDeleteAssistantTaskMutation,
    useUpdateAssistantContextParkingMutation,
    useUpdateAssistantTaskMutation,
    useUpsertAssistantStreakMutation,
} from "./useAssistantQueries";

// Expose CompletionStats shape for consumers
export interface CompletionStats {
    totalTasksCompleted: number;
    tasksCompletedThisWeek: number;
    tasksCompletedToday: number;
    totalFocusTime: number;
    criticalTasksCompleted: number;
    currentStreak: number;
    longestStreak: number;
}

/**
 * Minimal store for ephemeral UI error state
 */
interface TaskStoreState {
    error: string | null;
}

export const taskStore = new Store<TaskStoreState>({
    error: null,
});

/**
 * Hook to use the task store backed by SQLite via TanStack Query
 */
export function useTaskStore(userId: string | null) {
    const state = useStore(taskStore);
    const queryClient = useQueryClient();

    // Server queries
    const tasksQuery = useAssistantTasksQuery(userId);
    const streakQuery = useAssistantStreakQuery(userId);
    const badgesQuery = useAssistantBadgesQuery(userId);
    const parkingsQuery = useAssistantContextParkingsQuery(userId);

    const parkingsData = parkingsQuery.data;

    // Server mutations
    const createTaskMutation = useCreateAssistantTaskMutation();
    const updateTaskMutation = useUpdateAssistantTaskMutation();
    const deleteTaskMutation = useDeleteAssistantTaskMutation();
    const upsertStreakMutation = useUpsertAssistantStreakMutation();
    const createBadgeMutation = useCreateAssistantBadgeMutation();
    const createCompletionMutation = useCreateAssistantCompletionMutation();
    const createParkingMutation = useCreateAssistantContextParkingMutation();
    const updateParkingMutation = useUpdateAssistantContextParkingMutation();

    // Convert server tasks to app Task type
    const tasks: Task[] = useMemo(() => {
        return (tasksQuery.data ?? []).map((t) => ({
            id: t.id,
            userId: t.userId,
            title: t.title,
            description: t.description,
            projectId: t.projectId ?? undefined,
            deadline: t.deadline ? new Date(t.deadline) : undefined,
            urgencyLevel: t.urgencyLevel as Task["urgencyLevel"],
            isShippingBlocker: t.isShippingBlocker === 1,
            contextParkingLot: t.contextParkingLot ?? undefined,
            linkedGitHub: t.linkedGitHub ?? undefined,
            blockedBy: t.blockedBy as string[] | undefined,
            blocks: t.blocks as string[] | undefined,
            status: t.status as Task["status"],
            completedAt: t.completedAt ? new Date(t.completedAt) : undefined,
            focusTimeLogged: t.focusTimeLogged,
            createdAt: new Date(t.createdAt),
            updatedAt: new Date(t.updatedAt),
        }));
    }, [tasksQuery.data]);

    // Convert server streak to app Streak type
    const streak: Streak | null = useMemo(() => {
        if (!streakQuery.data) {
            return null;
        }

        return {
            userId: streakQuery.data.userId,
            currentStreakDays: streakQuery.data.currentStreakDays,
            longestStreakDays: streakQuery.data.longestStreakDays,
            lastTaskCompletionDate: new Date(streakQuery.data.lastTaskCompletionDate),
            streakResetDate: streakQuery.data.streakResetDate ? new Date(streakQuery.data.streakResetDate) : undefined,
        };
    }, [streakQuery.data]);

    // Convert server badges to app Badge type
    const badges: Badge[] = useMemo(() => {
        return (badgesQuery.data ?? []).map((b) => ({
            id: b.id,
            userId: b.userId,
            badgeType: b.badgeType as Badge["badgeType"],
            earnedAt: new Date(b.earnedAt),
            displayName: b.displayName,
            rarity: b.rarity as Badge["rarity"],
        }));
    }, [badgesQuery.data]);

    // Loading state
    const loading = tasksQuery.isLoading || streakQuery.isLoading || badgesQuery.isLoading;
    const initialized = !loading && tasksQuery.data !== undefined;

    // ============================================
    // Task Operations
    // ============================================

    async function createTask(input: TaskInput): Promise<Task | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const taskId = generateTaskId();

        const newTask = {
            id: taskId,
            userId,
            title: input.title,
            description: input.description ?? "",
            projectId: input.projectId ?? null,
            deadline: input.deadline?.toISOString() ?? null,
            urgencyLevel: input.urgencyLevel ?? "nice-to-have",
            isShippingBlocker: input.isShippingBlocker ? 1 : 0,
            contextParkingLot: null,
            linkedGitHub: input.linkedGitHub ?? null,
            blockedBy: [],
            blocks: [],
            status: input.status ?? "backlog",
            completedAt: null,
            focusTimeLogged: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
        };

        try {
            const result = await createTaskMutation.mutateAsync(newTask);
            if (!result) {
                throw new Error("Failed to create task");
            }

            return {
                ...input,
                id: result.id,
                userId,
                description: input.description ?? "",
                urgencyLevel: input.urgencyLevel ?? "nice-to-have",
                isShippingBlocker: input.isShippingBlocker ?? false,
                status: input.status ?? "backlog",
                focusTimeLogged: 0,
                createdAt: now,
                updatedAt: now,
            } as Task;
        } catch (err) {
            taskStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to create task",
            }));
            return null;
        }
    }

    async function updateTask(id: string, updates: TaskUpdate): Promise<Task | null> {
        if (!userId) {
            return null;
        }

        // Convert updates for server
        const serverUpdates: Record<string, unknown> = {};
        if (updates.title !== undefined) {
            serverUpdates.title = updates.title;
        }
        if (updates.description !== undefined) {
            serverUpdates.description = updates.description;
        }
        if (updates.projectId !== undefined) {
            serverUpdates.projectId = updates.projectId;
        }
        if (updates.deadline !== undefined) {
            serverUpdates.deadline = updates.deadline?.toISOString() ?? null;
        }
        if (updates.urgencyLevel !== undefined) {
            serverUpdates.urgencyLevel = updates.urgencyLevel;
        }
        if (updates.isShippingBlocker !== undefined) {
            serverUpdates.isShippingBlocker = updates.isShippingBlocker ? 1 : 0;
        }
        if (updates.contextParkingLot !== undefined) {
            serverUpdates.contextParkingLot = updates.contextParkingLot;
        }
        if (updates.linkedGitHub !== undefined) {
            serverUpdates.linkedGitHub = updates.linkedGitHub;
        }
        if (updates.blockedBy !== undefined) {
            serverUpdates.blockedBy = updates.blockedBy;
        }
        if (updates.blocks !== undefined) {
            serverUpdates.blocks = updates.blocks;
        }
        if (updates.status !== undefined) {
            serverUpdates.status = updates.status;
        }
        if (updates.completedAt !== undefined) {
            serverUpdates.completedAt = updates.completedAt?.toISOString() ?? null;
        }
        if (updates.focusTimeLogged !== undefined) {
            serverUpdates.focusTimeLogged = updates.focusTimeLogged;
        }

        try {
            const result = await updateTaskMutation.mutateAsync({ id, data: serverUpdates });
            if (!result) {
                throw new Error("Failed to update task");
            }

            const existingTask = tasks.find((t) => t.id === id);
            if (!existingTask) {
                return null;
            }

            return {
                ...existingTask,
                ...updates,
                updatedAt: new Date(),
            };
        } catch (err) {
            taskStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to update task",
            }));
            return null;
        }
    }

    async function deleteTask(id: string): Promise<boolean> {
        try {
            const result = await deleteTaskMutation.mutateAsync({ id, userId: userId! });
            return result.success;
        } catch (err) {
            taskStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to delete task",
            }));
            return false;
        }
    }

    function getTask(id: string): Task | undefined {
        return tasks.find((t) => t.id === id);
    }

    // ============================================
    // Task Completion
    // ============================================

    async function completeTask(
        id: string
    ): Promise<{ task: Task; completion: CompletionEvent; newBadges: Badge[] } | null> {
        if (!userId) {
            return null;
        }

        const task = tasks.find((t) => t.id === id);
        if (!task) {
            return null;
        }

        const now = new Date();

        const completedTask = await updateTask(id, {
            status: "completed",
            completedAt: now,
        });

        if (!completedTask) {
            return null;
        }

        const completionId = generateCompletionId();
        const completion: CompletionEvent = {
            id: completionId,
            userId,
            taskId: id,
            completionType: "task-complete",
            completedAt: now,
            celebrationShown: false,
            metadata: {
                focusTimeSpent: task.focusTimeLogged,
                taskUrgency: task.urgencyLevel,
            },
        };

        try {
            await createCompletionMutation.mutateAsync({
                id: completionId,
                userId,
                taskId: id,
                completionType: "task-complete",
                completedAt: now.toISOString(),
                celebrationShown: 0,
                metadata: completion.metadata,
            });
        } catch {
            // Continue even if completion logging fails
        }

        const completedTasks = tasks.filter((t) => t.status === "completed");
        const newStreakData = calculateStreak(completedTasks, now);

        try {
            await upsertStreakMutation.mutateAsync({
                userId,
                currentStreakDays: newStreakData.currentStreakDays,
                longestStreakDays: Math.max(newStreakData.currentStreakDays, streak?.longestStreakDays ?? 0),
                lastTaskCompletionDate: now.toISOString(),
                streakResetDate: newStreakData.streakResetDate?.toISOString() ?? null,
            });
        } catch {
            // Continue even if streak update fails
        }

        const newBadges: Badge[] = [];
        const totalCompleted = completedTasks.length + 1;
        const earnedBadgeTypes = badges.map((b) => b.badgeType);

        for (const def of BADGE_DEFINITIONS) {
            if (earnedBadgeTypes.includes(def.type)) {
                continue;
            }

            let earned = false;

            switch (def.requirement.type) {
                case "task-count":
                    earned = totalCompleted >= def.requirement.value;
                    break;
                case "streak-days":
                    earned = newStreakData.currentStreakDays >= def.requirement.value;
                    break;
                case "first-action":
                    if (def.requirement.action === "critical-complete") {
                        earned = task.urgencyLevel === "critical";
                    } else {
                        earned = totalCompleted >= 1;
                    }
                    break;
            }

            if (earned) {
                const badgeId = generateBadgeId();
                const newBadge: Badge = {
                    id: badgeId,
                    userId,
                    badgeType: def.type,
                    earnedAt: now,
                    displayName: def.displayName,
                    rarity: def.rarity,
                };

                try {
                    await createBadgeMutation.mutateAsync({
                        id: badgeId,
                        userId,
                        badgeType: def.type,
                        earnedAt: now.toISOString(),
                        displayName: def.displayName,
                        rarity: def.rarity,
                    });
                } catch {
                    // Continue even if badge creation fails
                }

                newBadges.push(newBadge);
            }
        }

        return { task: completedTask, completion, newBadges };
    }

    // ============================================
    // Context Parking
    // ============================================

    async function parkContext(input: ContextParkingInput): Promise<ContextParking | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const parkingId = `park_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        try {
            await createParkingMutation.mutateAsync({
                id: parkingId,
                userId,
                taskId: input.taskId,
                content: input.content,
                codeContext: input.codeContext ?? null,
                discoveryNotes: input.discoveryNotes ?? null,
                nextSteps: input.nextSteps ?? null,
                status: "active",
                parkedAt: now.toISOString(),
                resumedAt: null,
                createdAt: now.toISOString(),
            });

            return {
                id: parkingId,
                userId,
                taskId: input.taskId,
                content: input.content,
                codeContext: input.codeContext,
                discoveryNotes: input.discoveryNotes,
                nextSteps: input.nextSteps,
                status: "active",
                parkedAt: now,
                createdAt: now,
            };
        } catch (err) {
            taskStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to park context",
            }));
            return null;
        }
    }

    async function getActiveParking(taskId: string): Promise<ContextParking | null> {
        const parkings = parkingsData ?? [];
        const active = parkings.find((p) => p.taskId === taskId && p.status === "active");
        if (!active) {
            return null;
        }

        return {
            id: active.id,
            userId: active.userId,
            taskId: active.taskId,
            content: active.content,
            codeContext: active.codeContext as ContextParking["codeContext"],
            discoveryNotes: active.discoveryNotes ?? undefined,
            nextSteps: active.nextSteps ?? undefined,
            status: active.status as ContextParking["status"],
            parkedAt: new Date(active.parkedAt),
            resumedAt: active.resumedAt ? new Date(active.resumedAt) : undefined,
            createdAt: new Date(active.createdAt),
        };
    }

    async function getParkingHistory(taskId?: string): Promise<ContextParking[]> {
        const parkings = parkingsData ?? [];
        const filtered = taskId ? parkings.filter((p) => p.taskId === taskId) : parkings;

        return filtered.map((p) => ({
            id: p.id,
            userId: p.userId,
            taskId: p.taskId,
            content: p.content,
            codeContext: p.codeContext as ContextParking["codeContext"],
            discoveryNotes: p.discoveryNotes ?? undefined,
            nextSteps: p.nextSteps ?? undefined,
            status: p.status as ContextParking["status"],
            parkedAt: new Date(p.parkedAt),
            resumedAt: p.resumedAt ? new Date(p.resumedAt) : undefined,
            createdAt: new Date(p.createdAt),
        }));
    }

    async function resumeParking(parkingId: string): Promise<ContextParking | null> {
        if (!userId) {
            return null;
        }

        try {
            await updateParkingMutation.mutateAsync({
                id: parkingId,
                data: {
                    status: "resumed",
                    resumedAt: new Date().toISOString(),
                },
                userId,
            });

            queryClient.invalidateQueries({ queryKey: assistantKeys.parkingList(userId) });

            const parking = parkingsData?.find((p) => p.id === parkingId);
            if (!parking) {
                return null;
            }

            return {
                id: parking.id,
                userId: parking.userId,
                taskId: parking.taskId,
                content: parking.content,
                codeContext: parking.codeContext as ContextParking["codeContext"],
                discoveryNotes: parking.discoveryNotes ?? undefined,
                nextSteps: parking.nextSteps ?? undefined,
                status: "resumed",
                parkedAt: new Date(parking.parkedAt),
                resumedAt: new Date(),
                createdAt: new Date(parking.createdAt),
            };
        } catch (err) {
            taskStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to resume parking",
            }));
            return null;
        }
    }

    // ============================================
    // Statistics
    // ============================================

    function getCompletionStats(): CompletionStats | null {
        if (!userId) {
            return null;
        }

        const completedTasks = tasks.filter((t) => t.status === "completed");

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const thisWeekStart = new Date(today);
        thisWeekStart.setDate(today.getDate() - today.getDay());

        return {
            totalTasksCompleted: completedTasks.length,
            tasksCompletedThisWeek: completedTasks.filter((t) => {
                const completed = t.completedAt ? new Date(t.completedAt) : null;
                return completed && completed >= thisWeekStart;
            }).length,
            tasksCompletedToday: completedTasks.filter((t) => {
                const completed = t.completedAt ? new Date(t.completedAt) : null;
                return completed && completed >= today;
            }).length,
            totalFocusTime: completedTasks.reduce((sum, t) => sum + t.focusTimeLogged, 0),
            criticalTasksCompleted: completedTasks.filter((t) => t.urgencyLevel === "critical").length,
            currentStreak: streak?.currentStreakDays ?? 0,
            longestStreak: streak?.longestStreakDays ?? 0,
        };
    }

    // ============================================
    // Utilities
    // ============================================

    function clearError() {
        taskStore.setState((s) => ({ ...s, error: null }));
    }

    function getTasksByStatus(status: Task["status"]): Task[] {
        return tasks.filter((t) => t.status === status);
    }

    function getTasksByUrgency(urgency: Task["urgencyLevel"]): Task[] {
        return tasks.filter((t) => t.urgencyLevel === urgency);
    }

    function getActiveTasks(): Task[] {
        return tasks.filter((t) => t.status !== "completed");
    }

    function getCriticalTasks(): Task[] {
        return tasks.filter((t) => t.urgencyLevel === "critical" && t.status !== "completed");
    }

    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.taskList(userId) });
            queryClient.invalidateQueries({ queryKey: assistantKeys.streak(userId) });
            queryClient.invalidateQueries({ queryKey: assistantKeys.badgeList(userId) });
        }
    }

    return {
        // State
        tasks,
        streak,
        badges,
        loading,
        error: state.error,
        initialized,

        // Task operations
        createTask,
        updateTask,
        deleteTask,
        getTask,
        completeTask,

        // Context parking
        parkContext,
        getActiveParking,
        getParkingHistory,
        resumeParking,

        // Statistics
        getCompletionStats,

        // Utilities
        clearError,
        getTasksByStatus,
        getTasksByUrgency,
        getActiveTasks,
        getCriticalTasks,
        refresh,
    };
}

// Helper to calculate streak
function calculateStreak(completedTasks: Task[], now: Date): { currentStreakDays: number; streakResetDate?: Date } {
    if (completedTasks.length === 0) {
        return { currentStreakDays: 1, streakResetDate: now };
    }

    const sorted = [...completedTasks]
        .filter((t) => t.completedAt)
        .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());

    if (sorted.length === 0) {
        return { currentStreakDays: 1, streakResetDate: now };
    }

    let streakDays = 1;
    const currentDate = new Date(now);
    currentDate.setHours(0, 0, 0, 0);

    for (let i = 1; i <= 365; i++) {
        const checkDate = new Date(currentDate);
        checkDate.setDate(checkDate.getDate() - i);

        const hasCompletion = sorted.some((t) => {
            const completedDate = new Date(t.completedAt!);
            completedDate.setHours(0, 0, 0, 0);
            return completedDate.getTime() === checkDate.getTime();
        });

        if (hasCompletion) {
            streakDays++;
        } else {
            break;
        }
    }

    const streakResetDate = new Date(currentDate);
    streakResetDate.setDate(streakResetDate.getDate() - streakDays + 1);

    return { currentStreakDays: streakDays, streakResetDate };
}
