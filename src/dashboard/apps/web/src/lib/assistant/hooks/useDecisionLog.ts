/**
 * Decision Log Hook - Server-first with localStorage fallback
 *
 * Uses TanStack Query for server data with refetchOnWindowFocus.
 * Falls back to localStorage when server is unavailable.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import { useEffect, useMemo } from "react";
import { getAssistantStorageAdapter, initializeAssistantStorage } from "@/lib/assistant/lib/storage";
import type { DecisionQueryOptions } from "@/lib/assistant/lib/storage/types";
import type { Decision, DecisionInput, DecisionUpdate } from "@/lib/assistant/types";
import { generateDecisionId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantDecisionsQuery,
    useCreateAssistantDecisionMutation,
    useDeleteAssistantDecisionMutation,
    useUpdateAssistantDecisionMutation,
} from "./useAssistantQueries";

/**
 * Helper to parse JSONB fields from server response
 */
function parseJsonbField<T>(value: unknown, defaultValue: T): T {
    if (value === null || value === undefined) {
        return defaultValue;
    }
    if (Array.isArray(value)) {
        return value as T;
    }
    if (typeof value === "string") {
        try {
            return JSON.parse(value) as T;
        } catch {
            return defaultValue;
        }
    }
    return value as T;
}

/**
 * Decision log store state for fallback mode
 */
interface DecisionStoreState {
    fallbackMode: boolean;
    fallbackDecisions: Decision[];
    error: string | null;
}

/**
 * Create the decision store (for fallback state only)
 */
export const decisionStore = new Store<DecisionStoreState>({
    fallbackMode: false,
    fallbackDecisions: [],
    error: null,
});

/**
 * Hook to manage decision log entries
 * Server-first with localStorage fallback
 */
export function useDecisionLog(userId: string | null) {
    const state = useStore(decisionStore);
    const queryClient = useQueryClient();

    // Server queries
    const decisionsQuery = useAssistantDecisionsQuery(userId);

    // Server mutations
    const createMutation = useCreateAssistantDecisionMutation();
    const updateMutation = useUpdateAssistantDecisionMutation();
    const deleteMutation = useDeleteAssistantDecisionMutation();

    // Determine if we should use fallback mode
    const useFallback = state.fallbackMode || (decisionsQuery.isError && !decisionsQuery.data);

    // Initialize localStorage fallback if server fails
    useEffect(() => {
        if (!userId) {
            return;
        }

        if (decisionsQuery.isError && !state.fallbackMode) {
            const currentUserId = userId;

            async function loadFallback() {
                try {
                    const adapter = await initializeAssistantStorage();
                    const decisions = await adapter.getDecisions(currentUserId);

                    decisionStore.setState((s) => ({
                        ...s,
                        fallbackMode: true,
                        fallbackDecisions: decisions,
                    }));
                } catch (err) {
                    decisionStore.setState((s) => ({
                        ...s,
                        error: err instanceof Error ? err.message : "Failed to load fallback",
                    }));
                }
            }

            loadFallback();
        }
    }, [userId, decisionsQuery.isError, state.fallbackMode]);

    // Convert server decisions to app Decision type
    const decisions: Decision[] = useMemo(() => {
        if (useFallback) {
            return state.fallbackDecisions;
        }

        return (decisionsQuery.data ?? []).map((d) => ({
            id: d.id,
            userId: d.userId,
            title: d.title,
            reasoning: d.reasoning,
            alternativesConsidered: parseJsonbField<string[]>(d.alternativesConsidered, []),
            decidedAt: new Date(d.decidedAt),
            decidedBy: d.decidedBy,
            status: d.status as Decision["status"],
            supersededBy: d.supersededBy ?? undefined,
            reversalReason: d.reversalReason ?? undefined,
            impactArea: d.impactArea as Decision["impactArea"],
            relatedTaskIds: parseJsonbField<string[]>(d.relatedTaskIds, []),
            tags: parseJsonbField<string[]>(d.tags, []),
            createdAt: new Date(d.createdAt),
            updatedAt: new Date(d.updatedAt),
        }));
    }, [useFallback, state.fallbackDecisions, decisionsQuery.data]);

    // Loading state
    const loading = decisionsQuery.isLoading;
    const initialized = !loading && (decisionsQuery.data !== undefined || useFallback);

    /**
     * Create a new decision
     */
    async function createDecision(input: DecisionInput): Promise<Decision | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const decisionId = generateDecisionId();
        const decidedAt = input.decidedAt ?? now;

        if (useFallback) {
            try {
                const adapter = getAssistantStorageAdapter();
                return await adapter.createDecision(input, userId);
            } catch (err) {
                decisionStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to create decision",
                }));
                return null;
            }
        }

        try {
            const result = await createMutation.mutateAsync({
                id: decisionId,
                userId,
                title: input.title,
                reasoning: input.reasoning,
                alternativesConsidered: input.alternativesConsidered ?? [],
                decidedAt: decidedAt.toISOString(),
                decidedBy: input.decidedBy ?? "user",
                status: "active",
                supersededBy: null,
                reversalReason: null,
                impactArea: input.impactArea,
                relatedTaskIds: input.relatedTaskIds ?? [],
                tags: input.tags ?? [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            });

            if (!result) {
                throw new Error("Failed to create decision");
            }

            return {
                id: result.id,
                userId,
                title: input.title,
                reasoning: input.reasoning,
                alternativesConsidered: input.alternativesConsidered ?? [],
                decidedAt: decidedAt,
                decidedBy: input.decidedBy ?? "user",
                status: "active",
                impactArea: input.impactArea,
                relatedTaskIds: input.relatedTaskIds ?? [],
                tags: input.tags ?? [],
                createdAt: now,
                updatedAt: now,
            };
        } catch (err) {
            // Fall back to localStorage on error
            try {
                const adapter = await initializeAssistantStorage();
                return await adapter.createDecision(input, userId);
            } catch {
                decisionStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to create decision",
                }));
                return null;
            }
        }
    }

    /**
     * Update an existing decision
     */
    async function updateDecision(id: string, updates: DecisionUpdate): Promise<Decision | null> {
        if (!userId) {
            return null;
        }

        // Convert updates for server - use correct schema field names
        const serverUpdates: Record<string, unknown> = {};
        if (updates.title !== undefined) {
            serverUpdates.title = updates.title;
        }
        if (updates.reasoning !== undefined) {
            serverUpdates.reasoning = updates.reasoning;
        }
        if (updates.alternativesConsidered !== undefined) {
            serverUpdates.alternativesConsidered = updates.alternativesConsidered;
        }
        if (updates.decidedAt !== undefined) {
            serverUpdates.decidedAt = updates.decidedAt.toISOString();
        }
        if (updates.decidedBy !== undefined) {
            serverUpdates.decidedBy = updates.decidedBy;
        }
        if (updates.status !== undefined) {
            serverUpdates.status = updates.status;
        }
        if (updates.supersededBy !== undefined) {
            serverUpdates.supersededBy = updates.supersededBy;
        }
        if (updates.reversalReason !== undefined) {
            serverUpdates.reversalReason = updates.reversalReason;
        }
        if (updates.impactArea !== undefined) {
            serverUpdates.impactArea = updates.impactArea;
        }
        if (updates.relatedTaskIds !== undefined) {
            serverUpdates.relatedTaskIds = updates.relatedTaskIds;
        }
        if (updates.tags !== undefined) {
            serverUpdates.tags = updates.tags;
        }

        if (useFallback) {
            try {
                const adapter = getAssistantStorageAdapter();
                return await adapter.updateDecision(id, updates);
            } catch (err) {
                decisionStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to update decision",
                }));
                return null;
            }
        }

        try {
            const result = await updateMutation.mutateAsync({ id, data: serverUpdates, userId });
            if (!result) {
                throw new Error("Failed to update decision");
            }

            // Return the updated decision
            const existingDecision = decisions.find((d) => d.id === id);
            if (!existingDecision) {
                return null;
            }

            return {
                ...existingDecision,
                ...updates,
                updatedAt: new Date(),
            };
        } catch (err) {
            // Fall back to localStorage
            try {
                const adapter = await initializeAssistantStorage();
                return await adapter.updateDecision(id, updates);
            } catch {
                decisionStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to update decision",
                }));
                return null;
            }
        }
    }

    /**
     * Delete a decision
     */
    async function deleteDecision(id: string): Promise<boolean> {
        if (useFallback) {
            try {
                const adapter = getAssistantStorageAdapter();
                await adapter.deleteDecision(id);
                return true;
            } catch (err) {
                decisionStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to delete decision",
                }));
                return false;
            }
        }

        try {
            const result = await deleteMutation.mutateAsync({ id, userId: userId! });
            return result.success;
        } catch (err) {
            decisionStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to delete decision",
            }));
            return false;
        }
    }

    /**
     * Supersede a decision with a new one
     */
    async function supersedeDecision(
        oldDecisionId: string,
        newDecision: DecisionInput
    ): Promise<{ oldDecision: Decision; newDecision: Decision } | null> {
        if (!userId) {
            return null;
        }

        try {
            // Create new decision first
            const newDec = await createDecision(newDecision);
            if (!newDec) {
                throw new Error("Failed to create new decision");
            }

            // Mark old decision as superseded
            const oldDec = await updateDecision(oldDecisionId, {
                status: "superseded",
                supersededBy: newDec.id,
            });

            if (!oldDec) {
                throw new Error("Failed to mark old decision as superseded");
            }

            return { oldDecision: oldDec, newDecision: newDec };
        } catch (err) {
            decisionStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to supersede decision",
            }));
            return null;
        }
    }

    /**
     * Reverse a decision
     */
    async function reverseDecision(id: string, reason: string): Promise<Decision | null> {
        return updateDecision(id, {
            status: "reversed",
            reversalReason: reason,
        });
    }

    /**
     * Get a decision by ID
     */
    function getDecision(id: string): Decision | undefined {
        return decisions.find((d) => d.id === id);
    }

    /**
     * Query decisions with filters (falls back to local filtering)
     */
    async function queryDecisions(options: DecisionQueryOptions): Promise<Decision[]> {
        if (!userId) {
            return [];
        }

        // For server mode, we filter locally since we have all decisions
        let filtered = [...decisions];

        if (options.status) {
            filtered = filtered.filter((d) => d.status === options.status);
        }
        if (options.impactArea) {
            filtered = filtered.filter((d) => d.impactArea === options.impactArea);
        }
        if (options.relatedTaskId) {
            filtered = filtered.filter((d) => d.relatedTaskIds.includes(options.relatedTaskId!));
        }
        if (options.tags && options.tags.length > 0) {
            filtered = filtered.filter((d) => options.tags?.some((tag) => d.tags.includes(tag)));
        }
        if (options.startDate) {
            filtered = filtered.filter((d) => d.decidedAt >= options.startDate!);
        }
        if (options.endDate) {
            filtered = filtered.filter((d) => d.decidedAt <= options.endDate!);
        }

        // Sort by decidedAt descending
        filtered.sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime());

        if (options.limit) {
            filtered = filtered.slice(0, options.limit);
        }

        return filtered;
    }

    /**
     * Get active decisions only
     */
    function getActiveDecisions(): Decision[] {
        return decisions.filter((d) => d.status === "active");
    }

    /**
     * Get superseded decisions
     */
    function getSupersededDecisions(): Decision[] {
        return decisions.filter((d) => d.status === "superseded");
    }

    /**
     * Get reversed decisions
     */
    function getReversedDecisions(): Decision[] {
        return decisions.filter((d) => d.status === "reversed");
    }

    /**
     * Get decisions by impact area
     */
    function getByImpactArea(impactArea: Decision["impactArea"]): Decision[] {
        return decisions.filter((d) => d.impactArea === impactArea);
    }

    /**
     * Get decisions related to a task
     */
    function getByTaskId(taskId: string): Decision[] {
        return decisions.filter((d) => d.relatedTaskIds.includes(taskId));
    }

    /**
     * Get decisions with a specific tag
     */
    function getByTag(tag: string): Decision[] {
        return decisions.filter((d) => d.tags.includes(tag));
    }

    /**
     * Get decision that superseded another
     */
    function getSupersedingDecision(decisionId: string): Decision | undefined {
        const decision = decisions.find((d) => d.id === decisionId);
        if (decision?.supersededBy) {
            return decisions.find((d) => d.id === decision.supersededBy);
        }
        return undefined;
    }

    /**
     * Get decision chain (original -> superseding -> etc)
     */
    function getDecisionChain(decisionId: string): Decision[] {
        const chain: Decision[] = [];
        let current = decisions.find((d) => d.id === decisionId);

        while (current) {
            chain.push(current);
            if (current.supersededBy) {
                current = decisions.find((d) => d.id === current?.supersededBy);
            } else {
                break;
            }
        }

        return chain;
    }

    /**
     * Get all unique tags
     */
    function getAllTags(): string[] {
        const tagSet = new Set<string>();
        for (const decision of decisions) {
            for (const tag of decision.tags) {
                tagSet.add(tag);
            }
        }
        return Array.from(tagSet).sort();
    }

    /**
     * Get recent decisions (last N days)
     */
    function getRecentDecisions(days = 30): Decision[] {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        return decisions.filter((d) => d.decidedAt >= cutoff);
    }

    /**
     * Clear error
     */
    function clearError() {
        decisionStore.setState((s) => ({ ...s, error: null }));
    }

    /**
     * Manual refresh
     */
    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.decisionList(userId) });
        }
    }

    return {
        // State
        decisions,
        loading,
        error: state.error,
        initialized,

        // CRUD operations
        createDecision,
        updateDecision,
        deleteDecision,
        getDecision,
        queryDecisions,

        // Supersede/Reverse
        supersedeDecision,
        reverseDecision,

        // Filters
        getActiveDecisions,
        getSupersededDecisions,
        getReversedDecisions,
        getByImpactArea,
        getByTaskId,
        getByTag,
        getSupersedingDecision,
        getDecisionChain,
        getAllTags,
        getRecentDecisions,

        // Utilities
        clearError,
        refresh,

        // Server status
        isServerMode: !useFallback,
    };
}
