/**
 * Task Store Hook - Server-first with localStorage fallback
 *
 * Uses TanStack Query for server data with refetchOnWindowFocus.
 * Falls back to localStorage when server is unavailable.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import { useEffect, useMemo } from "react";
import { getAssistantStorageAdapter, initializeAssistantStorage } from "@/lib/assistant/lib/storage";
import type { CompletionStats } from "@/lib/assistant/lib/storage/types";
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
    useAssistantCompletionsQuery,
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

/**
 * Task store state for fallback mode
 */
interface TaskStoreState {
    fallbackMode: boolean;
    fallbackTasks: Task[];
    fallbackStreak: Streak | null;
    fallbackBadges: Badge[];
    error: string | null;
}

/**
 * Create the task store (for fallback state only)
 */
export const taskStore = new Store<TaskStoreState>({
    fallbackMode: false,
    fallbackTasks: [],
    fallbackStreak: null,
    fallbackBadges: [],
    error: null,
});

/**
 * Hook to use the task store with server-first, localStorage fallback
 */
export function useTaskStore(userId: string | null) {
    const state = useStore(taskStore);
    const queryClient = useQueryClient();

    // Server queries
    const tasksQuery = useAssistantTasksQuery(userId);
    const streakQuery = useAssistantStreakQuery(userId);
    const badgesQuery = useAssistantBadgesQuery(userId);
    const completionsQuery = useAssistantCompletionsQuery(userId);
    const parkingsQuery = useAssistantContextParkingsQuery(userId);

    // Server mutations
    const createTaskMutation = useCreateAssistantTaskMutation();
    const updateTaskMutation = useUpdateAssistantTaskMutation();
    const deleteTaskMutation = useDeleteAssistantTaskMutation();
    const upsertStreakMutation = useUpsertAssistantStreakMutation();
    const createBadgeMutation = useCreateAssistantBadgeMutation();
    const createCompletionMutation = useCreateAssistantCompletionMutation();
    const createParkingMutation = useCreateAssistantContextParkingMutation();
    const updateParkingMutation = useUpdateAssistantContextParkingMutation();

    // Determine if we should use fallback mode
    const useFallback = state.fallbackMode || (tasksQuery.isError && !tasksQuery.data);

    // Initialize localStorage fallback if server fails
    useEffect(() => {
        if (!userId) {
            return;
        }

        // If server query failed, enable fallback mode and load from localStorage
        if (tasksQuery.isError && !state.fallbackMode) {
            const currentUserId = userId;

            async function loadFallback() {
                try {
                    const adapter = await initializeAssistantStorage();
                    const [tasks, streak, badges] = await Promise.all([
                        adapter.getTasks(currentUserId),
                        adapter.getStreak(currentUserId),
                        adapter.getBadges(currentUserId),
                    ]);

                    taskStore.setState((s) => ({
                        ...s,
                        fallbackMode: true,
                        fallbackTasks: tasks,
                        fallbackStreak: streak,
                        fallbackBadges: badges,
                    }));
                } catch (err) {
                    taskStore.setState((s) => ({
                        ...s,
                        error: err instanceof Error ? err.message : "Failed to load fallback",
                    }));
                }
            }

            loadFallback();
        }
    }, [userId, tasksQuery.isError, state.fallbackMode]);

    // Convert server tasks to app Task type
    const tasks: Task[] = useMemo(() => {
        if (useFallback) {
            return state.fallbackTasks;
        }

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
    }, [useFallback, state.fallbackTasks, tasksQuery.data]);

    // Convert server streak to app Streak type
    const streak: Streak | null = useMemo(() => {
        if (useFallback) {
            return state.fallbackStreak;
        }
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
    }, [useFallback, state.fallbackStreak, streakQuery.data]);

    // Convert server badges to app Badge type
    const badges: Badge[] = useMemo(() => {
        if (useFallback) {
            return state.fallbackBadges;
        }

        return (badgesQuery.data ?? []).map((b) => ({
            id: b.id,
            userId: b.userId,
            badgeType: b.badgeType as Badge["badgeType"],
            earnedAt: new Date(b.earnedAt),
            displayName: b.displayName,
            rarity: b.rarity as Badge["rarity"],
        }));
    }, [useFallback, state.fallbackBadges, badgesQuery.data]);

    // Loading state
    const loading = tasksQuery.isLoading || streakQuery.isLoading || badgesQuery.isLoading;
    const initialized = !loading && (tasksQuery.data !== undefined || useFallback);

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

        if (useFallback) {
            try {
                const adapter = getAssistantStorageAdapter();
                return await adapter.createTask(input, userId);
            } catch (err) {
                taskStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to create task",
                }));
                return null;
            }
        }

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
            // Fall back to localStorage on error
            try {
                const adapter = await initializeAssistantStorage();
                return await adapter.createTask(input, userId);
            } catch {
                taskStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to create task",
                }));
                return null;
            }
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

        if (useFallback) {
            try {
                const adapter = getAssistantStorageAdapter();
                return await adapter.updateTask(id, updates);
            } catch (err) {
                taskStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to update task",
                }));
                return null;
            }
        }

        try {
            const result = await updateTaskMutation.mutateAsync({ id, data: serverUpdates });
            if (!result) {
                throw new Error("Failed to update task");
            }

            // Return the updated task
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
            // Fall back to localStorage
            try {
                const adapter = await initializeAssistantStorage();
                return await adapter.updateTask(id, updates);
            } catch {
                taskStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to update task",
                }));
                return null;
            }
        }
    }

    async function deleteTask(id: string): Promise<boolean> {
        if (useFallback) {
            try {
                const adapter = getAssistantStorageAdapter();
                await adapter.deleteTask(id);
                return true;
            } catch (err) {
                taskStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to delete task",
                }));
                return false;
            }
        }

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

        // Update task to completed
        const completedTask = await updateTask(id, {
            status: "completed",
            completedAt: now,
        });

        if (!completedTask) {
            return null;
        }

        // Log completion event
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

        if (!useFallback) {
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
        }

        // Update streak
        const completedTasks = tasks.filter((t) => t.status === "completed");
        const newStreakData = calculateStreak(completedTasks, now);

        if (!useFallback) {
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
        }

        // Check for new badges
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

                if (!useFallback) {
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

        if (useFallback) {
            try {
                const adapter = getAssistantStorageAdapter();
                return await adapter.parkContext(input, userId);
            } catch (err) {
                taskStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to park context",
                }));
                return null;
            }
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
            // Fall back to localStorage
            try {
                const adapter = await initializeAssistantStorage();
                return await adapter.parkContext(input, userId);
            } catch {
                taskStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to park context",
                }));
                return null;
            }
        }
    }

    async function getActiveParking(taskId: string): Promise<ContextParking | null> {
        const parkings = parkingsQuery.data ?? [];
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
        if (!userId) {
            return [];
        }

        const parkings = parkingsQuery.data ?? [];
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

            // Invalidate to refetch
            queryClient.invalidateQueries({ queryKey: assistantKeys.parkingList(userId) });

            const parking = parkingsQuery.data?.find((p) => p.id === parkingId);
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

    async function getCompletionStats(): Promise<CompletionStats | null> {
        if (!userId) {
            return null;
        }

        const completedTasks = tasks.filter((t) => t.status === "completed");
        const _completions = completionsQuery.data ?? [];

        // Calculate stats from data
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const thisWeekStart = new Date(today);
        thisWeekStart.setDate(today.getDate() - today.getDay());

        const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);

        return {
            totalTasks: completedTasks.length,
            completedThisWeek: completedTasks.filter((t) => {
                const completed = t.completedAt ? new Date(t.completedAt) : null;
                return completed && completed >= thisWeekStart;
            }).length,
            completedThisMonth: completedTasks.filter((t) => {
                const completed = t.completedAt ? new Date(t.completedAt) : null;
                return completed && completed >= thisMonthStart;
            }).length,
            focusTimeTotal: completedTasks.reduce((sum, t) => sum + t.focusTimeLogged, 0),
            streakDays: streak?.currentStreakDays ?? 0,
            badgesEarned: badges.length,
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

    // Manual refresh
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

        // Server status
        isServerMode: !useFallback,
    };
}

// Helper to calculate streak
function calculateStreak(completedTasks: Task[], now: Date): { currentStreakDays: number; streakResetDate?: Date } {
    if (completedTasks.length === 0) {
        return { currentStreakDays: 1, streakResetDate: now };
    }

    // Sort by completion date descending
    const sorted = [...completedTasks]
        .filter((t) => t.completedAt)
        .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());

    if (sorted.length === 0) {
        return { currentStreakDays: 1, streakResetDate: now };
    }

    let streakDays = 1;
    const currentDate = new Date(now);
    currentDate.setHours(0, 0, 0, 0);

    // Check each previous day
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
