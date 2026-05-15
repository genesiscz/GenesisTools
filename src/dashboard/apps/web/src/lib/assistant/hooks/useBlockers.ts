/**
 * Blockers Hook - Server-first via TanStack Query + SQLite
 */

import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import { useMemo } from "react";
import type { TaskBlocker, TaskBlockerInput, TaskBlockerUpdate } from "@/lib/assistant/types";
import { generateBlockerId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantBlockersQuery,
    useCreateAssistantBlockerMutation,
    useResolveAssistantBlockerMutation,
    useUpdateAssistantBlockerMutation,
} from "./useAssistantQueries";

interface BlockersStoreState {
    error: string | null;
}

export const blockersStore = new Store<BlockersStoreState>({
    error: null,
});

export function useBlockers(userId: string | null) {
    const state = useStore(blockersStore);
    const queryClient = useQueryClient();

    const blockersQuery = useAssistantBlockersQuery(userId);

    const createMutation = useCreateAssistantBlockerMutation();
    const updateMutation = useUpdateAssistantBlockerMutation();
    const resolveMutation = useResolveAssistantBlockerMutation();

    const blockers: TaskBlocker[] = useMemo(() => {
        return (blockersQuery.data ?? []).map((b) => ({
            id: b.id,
            userId: b.userId,
            taskId: b.taskId,
            reason: b.reason,
            blockerOwner: b.blockerOwner ?? undefined,
            blockedSince: new Date(b.blockedSince),
            unblockedAt: b.unblockedAt ? new Date(b.unblockedAt) : undefined,
            reminderSet: b.reminderSet ? new Date(b.reminderSet) : undefined,
            createdAt: new Date(b.createdAt),
            updatedAt: new Date(b.updatedAt),
        }));
    }, [blockersQuery.data]);

    const loading = blockersQuery.isLoading;
    const initialized = !loading && blockersQuery.data !== undefined;

    async function addBlocker(input: TaskBlockerInput): Promise<TaskBlocker | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const blockerId = generateBlockerId();

        try {
            const result = await createMutation.mutateAsync({
                id: blockerId,
                userId,
                taskId: input.taskId,
                reason: input.reason,
                blockerOwner: input.blockerOwner ?? null,
                blockedSince: now.toISOString(),
                unblockedAt: null,
                reminderSet: input.reminderSet?.toISOString() ?? null,
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            });

            if (!result) {
                throw new Error("Failed to add blocker");
            }

            return {
                id: result.id,
                userId,
                taskId: input.taskId,
                reason: input.reason,
                blockerOwner: input.blockerOwner,
                blockedSince: now,
                reminderSet: input.reminderSet,
                createdAt: now,
                updatedAt: now,
            };
        } catch (err) {
            blockersStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to add blocker",
            }));
            return null;
        }
    }

    async function updateBlocker(id: string, updates: TaskBlockerUpdate): Promise<TaskBlocker | null> {
        if (!userId) {
            return null;
        }

        const serverUpdates: Record<string, unknown> = {};
        if (updates.reason !== undefined) {
            serverUpdates.reason = updates.reason;
        }
        if (updates.blockerOwner !== undefined) {
            serverUpdates.blockerOwner = updates.blockerOwner;
        }
        if (updates.reminderSet !== undefined) {
            serverUpdates.reminderSet = updates.reminderSet?.toISOString() ?? null;
        }

        const existingBlocker = blockers.find((b) => b.id === id);
        if (!existingBlocker) {
            return null;
        }

        try {
            const result = await updateMutation.mutateAsync({
                id,
                data: serverUpdates,
                userId,
                taskId: existingBlocker.taskId,
            });
            if (!result) {
                throw new Error("Failed to update blocker");
            }

            return {
                ...existingBlocker,
                ...updates,
                updatedAt: new Date(),
            };
        } catch (err) {
            blockersStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to update blocker",
            }));
            return null;
        }
    }

    async function resolveBlocker(id: string): Promise<TaskBlocker | null> {
        try {
            const existingBlocker = blockers.find((b) => b.id === id);
            if (!existingBlocker) {
                throw new Error("Blocker not found");
            }

            const result = await resolveMutation.mutateAsync({ id, userId: userId!, taskId: existingBlocker.taskId });
            if (!result) {
                throw new Error("Failed to resolve blocker");
            }

            return {
                ...existingBlocker,
                unblockedAt: new Date(),
                updatedAt: new Date(),
            };
        } catch (err) {
            blockersStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to resolve blocker",
            }));
            return null;
        }
    }

    async function deleteBlocker(id: string): Promise<boolean> {
        const result = await resolveBlocker(id);
        return result !== null;
    }

    function getBlocker(id: string): TaskBlocker | undefined {
        return blockers.find((b) => b.id === id);
    }

    function getActiveBlockers(): TaskBlocker[] {
        return blockers.filter((b) => !b.unblockedAt);
    }

    function getResolvedBlockers(): TaskBlocker[] {
        return blockers.filter((b) => b.unblockedAt);
    }

    function getBlockersForTask(taskId: string): TaskBlocker[] {
        return blockers.filter((b) => b.taskId === taskId);
    }

    function getActiveBlockerForTask(taskId: string): TaskBlocker | undefined {
        return blockers.find((b) => b.taskId === taskId && !b.unblockedAt);
    }

    function isTaskBlocked(taskId: string): boolean {
        return blockers.some((b) => b.taskId === taskId && !b.unblockedAt);
    }

    function getBlockersByOwner(owner: string): TaskBlocker[] {
        return blockers.filter((b) => b.blockerOwner === owner);
    }

    function getBlockersWithReminders(): TaskBlocker[] {
        return blockers.filter((b) => b.reminderSet && !b.unblockedAt);
    }

    function getBlockersWithDueReminders(): TaskBlocker[] {
        const now = new Date();
        return blockers.filter((b) => b.reminderSet && !b.unblockedAt && b.reminderSet <= now);
    }

    function getLongStandingBlockers(days = 3): TaskBlocker[] {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        return blockers.filter((b) => !b.unblockedAt && b.blockedSince <= cutoff);
    }

    function getBlockerDurationDays(blocker: TaskBlocker): number {
        const endDate = blocker.unblockedAt ? blocker.unblockedAt : new Date();
        const startDate = blocker.blockedSince;
        return Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    }

    function getAverageBlockDuration(): number {
        const resolved = getResolvedBlockers();
        if (resolved.length === 0) {
            return 0;
        }

        const totalDays = resolved.reduce((sum, b) => sum + getBlockerDurationDays(b), 0);
        return totalDays / resolved.length;
    }

    function clearError() {
        blockersStore.setState((s) => ({ ...s, error: null }));
    }

    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.blockerList(userId) });
        }
    }

    return {
        blockers,
        loading,
        error: state.error,
        initialized,
        addBlocker,
        updateBlocker,
        resolveBlocker,
        deleteBlocker,
        getBlocker,
        getActiveBlockers,
        getResolvedBlockers,
        getBlockersForTask,
        getActiveBlockerForTask,
        isTaskBlocked,
        getBlockersByOwner,
        getBlockersWithReminders,
        getBlockersWithDueReminders,
        getLongStandingBlockers,
        getBlockerDurationDays,
        getAverageBlockDuration,
        clearError,
        refresh,
    };
}
