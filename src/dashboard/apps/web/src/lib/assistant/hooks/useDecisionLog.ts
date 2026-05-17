/**
 * Decision Log Hook - Server-first via TanStack Query + SQLite
 */

import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import { useMemo } from "react";
import type { Decision, DecisionInput, DecisionUpdate } from "@/lib/assistant/types";
import { generateDecisionId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantDecisionsQuery,
    useCreateAssistantDecisionMutation,
    useDeleteAssistantDecisionMutation,
    useUpdateAssistantDecisionMutation,
} from "./useAssistantQueries";

interface DecisionStoreState {
    error: string | null;
}

export const decisionStore = new Store<DecisionStoreState>({
    error: null,
});

export function useDecisionLog(userId: string | null) {
    const state = useStore(decisionStore);
    const queryClient = useQueryClient();

    const decisionsQuery = useAssistantDecisionsQuery(userId);
    const createMutation = useCreateAssistantDecisionMutation();
    const updateMutation = useUpdateAssistantDecisionMutation();
    const deleteMutation = useDeleteAssistantDecisionMutation();

    const decisions: Decision[] = useMemo(() => {
        return (decisionsQuery.data ?? []).map((d) => ({
            id: d.id,
            userId: d.userId,
            title: d.title,
            reasoning: d.reasoning,
            alternativesConsidered: (d.alternativesConsidered as string[]) ?? [],
            decidedAt: new Date(d.decidedAt),
            decidedBy: d.decidedBy,
            status: d.status as Decision["status"],
            supersededBy: d.supersededBy ?? undefined,
            reversalReason: d.reversalReason ?? undefined,
            impactArea: d.impactArea as Decision["impactArea"],
            relatedTaskIds: (d.relatedTaskIds as string[]) ?? [],
            tags: (d.tags as string[]) ?? [],
            createdAt: new Date(d.createdAt),
            updatedAt: new Date(d.updatedAt),
        }));
    }, [decisionsQuery.data]);

    const loading = decisionsQuery.isLoading;
    const initialized = !loading && decisionsQuery.data !== undefined;

    async function createDecision(input: DecisionInput): Promise<Decision | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const decisionId = generateDecisionId();
        const decidedAt = input.decidedAt ?? now;

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
                decidedAt,
                decidedBy: input.decidedBy ?? "user",
                status: "active",
                impactArea: input.impactArea,
                relatedTaskIds: input.relatedTaskIds ?? [],
                tags: input.tags ?? [],
                createdAt: now,
                updatedAt: now,
            };
        } catch (err) {
            decisionStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to create decision",
            }));
            return null;
        }
    }

    async function updateDecision(id: string, updates: DecisionUpdate): Promise<Decision | null> {
        if (!userId) {
            return null;
        }

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

        try {
            const result = await updateMutation.mutateAsync({ id, data: serverUpdates, userId });
            if (!result) {
                throw new Error("Failed to update decision");
            }

            const existingDecision = decisions.find((d) => d.id === id);
            if (!existingDecision) {
                return null;
            }

            return { ...existingDecision, ...updates, updatedAt: new Date() };
        } catch (err) {
            decisionStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to update decision",
            }));
            return null;
        }
    }

    async function deleteDecision(id: string): Promise<boolean> {
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

    async function supersedeDecision(
        oldDecisionId: string,
        newDecision: DecisionInput
    ): Promise<{ oldDecision: Decision; newDecision: Decision } | null> {
        if (!userId) {
            return null;
        }

        try {
            const newDec = await createDecision(newDecision);
            if (!newDec) {
                throw new Error("Failed to create new decision");
            }

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

    async function reverseDecision(id: string, reason: string): Promise<Decision | null> {
        return updateDecision(id, { status: "reversed", reversalReason: reason });
    }

    function getDecision(id: string): Decision | undefined {
        return decisions.find((d) => d.id === id);
    }

    function getActiveDecisions(): Decision[] {
        return decisions.filter((d) => d.status === "active");
    }

    function getSupersededDecisions(): Decision[] {
        return decisions.filter((d) => d.status === "superseded");
    }

    function getReversedDecisions(): Decision[] {
        return decisions.filter((d) => d.status === "reversed");
    }

    function getByImpactArea(impactArea: Decision["impactArea"]): Decision[] {
        return decisions.filter((d) => d.impactArea === impactArea);
    }

    function getByTaskId(taskId: string): Decision[] {
        return decisions.filter((d) => d.relatedTaskIds.includes(taskId));
    }

    function getByTag(tag: string): Decision[] {
        return decisions.filter((d) => d.tags.includes(tag));
    }

    function getSupersedingDecision(decisionId: string): Decision | undefined {
        const decision = decisions.find((d) => d.id === decisionId);
        if (decision?.supersededBy) {
            return decisions.find((d) => d.id === decision.supersededBy);
        }
        return undefined;
    }

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

    function getAllTags(): string[] {
        const tagSet = new Set<string>();
        for (const decision of decisions) {
            for (const tag of decision.tags) {
                tagSet.add(tag);
            }
        }
        return Array.from(tagSet).sort();
    }

    function getRecentDecisions(days = 30): Decision[] {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        return decisions.filter((d) => d.decidedAt >= cutoff);
    }

    function clearError() {
        decisionStore.setState((s) => ({ ...s, error: null }));
    }

    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.decisionList(userId) });
        }
    }

    return {
        decisions,
        loading,
        error: state.error,
        initialized,
        createDecision,
        updateDecision,
        deleteDecision,
        getDecision,
        supersedeDecision,
        reverseDecision,
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
        clearError,
        refresh,
    };
}
