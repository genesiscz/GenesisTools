import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { HandoffDocument, HandoffDocumentInput, HandoffDocumentUpdate } from "@/lib/assistant/types";
import { generateHandoffId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantHandoffsQuery,
    useCreateAssistantHandoffMutation,
    useUpdateAssistantHandoffMutation,
} from "./useAssistantQueries";

export function useHandoff(userId: string | null) {
    const queryClient = useQueryClient();
    const [error, setError] = useState<string | null>(null);

    const handoffsQuery = useAssistantHandoffsQuery(userId);
    const createMutation = useCreateAssistantHandoffMutation();
    const updateMutation = useUpdateAssistantHandoffMutation();

    const handoffs: HandoffDocument[] = useMemo(() => {
        return (handoffsQuery.data ?? []).map((h) => ({
            id: h.id,
            userId: h.userId,
            taskId: h.taskId,
            summary: h.summary,
            contextNotes: h.contextNotes,
            nextSteps: (h.nextSteps as string[]) ?? [],
            gotchas: h.gotchas ?? undefined,
            decisions: (h.decisions as string[]) ?? [],
            blockers: (h.blockers as string[]) ?? [],
            handedOffFrom: h.handedOffFrom,
            handedOffTo: h.handedOffTo,
            contact: h.contact,
            reviewed: h.reviewed === 1,
            reviewedAt: h.reviewedAt ? new Date(h.reviewedAt) : undefined,
            handoffAt: new Date(h.handoffAt),
            createdAt: new Date(h.createdAt),
            updatedAt: new Date(h.updatedAt),
        }));
    }, [handoffsQuery.data]);

    const loading = handoffsQuery.isLoading;

    async function createHandoff(input: HandoffDocumentInput): Promise<HandoffDocument | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const handoffId = generateHandoffId();
        const handedOffFrom = userId;
        const handoffAt = now;

        try {
            const result = await createMutation.mutateAsync({
                id: handoffId,
                userId,
                taskId: input.taskId,
                summary: input.summary,
                contextNotes: input.contextNotes,
                nextSteps: input.nextSteps,
                gotchas: input.gotchas ?? null,
                decisions: input.decisions ?? [],
                blockers: input.blockers ?? [],
                handedOffFrom,
                handedOffTo: input.handedOffTo,
                contact: input.contact,
                reviewed: 0,
                reviewedAt: null,
                handoffAt: handoffAt.toISOString(),
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            });

            if (!result) {
                throw new Error("Failed to create handoff");
            }

            return {
                id: result.id,
                userId,
                taskId: input.taskId,
                summary: input.summary,
                contextNotes: input.contextNotes,
                nextSteps: input.nextSteps,
                gotchas: input.gotchas,
                decisions: input.decisions ?? [],
                blockers: input.blockers ?? [],
                handedOffFrom,
                handedOffTo: input.handedOffTo,
                contact: input.contact,
                reviewed: false,
                handoffAt,
                createdAt: now,
                updatedAt: now,
            };
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create handoff");
            return null;
        }
    }

    async function updateHandoff(id: string, updates: HandoffDocumentUpdate): Promise<HandoffDocument | null> {
        if (!userId) {
            return null;
        }

        const serverUpdates: Record<string, unknown> = {};
        if (updates.summary !== undefined) {
            serverUpdates.summary = updates.summary;
        }
        if (updates.contextNotes !== undefined) {
            serverUpdates.contextNotes = updates.contextNotes;
        }
        if (updates.nextSteps !== undefined) {
            serverUpdates.nextSteps = updates.nextSteps;
        }
        if (updates.gotchas !== undefined) {
            serverUpdates.gotchas = updates.gotchas;
        }
        if (updates.decisions !== undefined) {
            serverUpdates.decisions = updates.decisions;
        }
        if (updates.blockers !== undefined) {
            serverUpdates.blockers = updates.blockers;
        }
        if (updates.contact !== undefined) {
            serverUpdates.contact = updates.contact;
        }
        if (updates.reviewed !== undefined) {
            serverUpdates.reviewed = updates.reviewed ? 1 : 0;
        }
        if (updates.reviewedAt !== undefined) {
            serverUpdates.reviewedAt = updates.reviewedAt?.toISOString() ?? null;
        }

        const existingHandoff = handoffs.find((h) => h.id === id);
        if (!existingHandoff) {
            return null;
        }

        try {
            const result = await updateMutation.mutateAsync({
                id,
                data: serverUpdates,
                userId,
                taskId: existingHandoff.taskId,
            });
            if (!result) {
                throw new Error("Failed to update handoff");
            }

            return {
                ...existingHandoff,
                ...updates,
                updatedAt: new Date(),
            };
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update handoff");
            return null;
        }
    }

    async function acknowledgeHandoff(id: string): Promise<HandoffDocument | null> {
        return updateHandoff(id, {
            reviewed: true,
            reviewedAt: new Date(),
        });
    }

    async function deleteHandoff(id: string): Promise<boolean> {
        // Preserve history by marking as reviewed
        const result = await acknowledgeHandoff(id);
        return result !== null;
    }

    function getHandoff(id: string): HandoffDocument | undefined {
        return handoffs.find((h) => h.id === id);
    }

    function getHandoffsForTask(taskId: string): HandoffDocument[] {
        return handoffs.filter((h) => h.taskId === taskId);
    }

    function getPendingHandoffs(): HandoffDocument[] {
        return handoffs.filter((h) => !h.reviewed);
    }

    function getReviewedHandoffs(): HandoffDocument[] {
        return handoffs.filter((h) => h.reviewed);
    }

    function getMyCreatedHandoffs(): HandoffDocument[] {
        if (!userId) {
            return [];
        }
        return handoffs.filter((h) => h.handedOffFrom === userId);
    }

    function getHandoffsAssignedToMe(): HandoffDocument[] {
        if (!userId) {
            return [];
        }
        return handoffs.filter((h) => h.handedOffTo === userId);
    }

    function getRecentHandoffs(days = 7): HandoffDocument[] {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        return handoffs.filter((h) => h.handoffAt >= cutoff);
    }

    function generateHandoffMarkdown(handoff: HandoffDocument): string {
        const lines: string[] = [
            `# Handoff: ${handoff.summary}`,
            "",
            `**From:** ${handoff.handedOffFrom}`,
            `**To:** ${handoff.handedOffTo}`,
            `**Date:** ${handoff.handoffAt.toLocaleDateString()}`,
            "",
            "## Context",
            handoff.contextNotes,
            "",
        ];

        if (handoff.nextSteps.length > 0) {
            lines.push("## Next Steps");
            for (const step of handoff.nextSteps) {
                lines.push(`- [ ] ${step}`);
            }
            lines.push("");
        }

        if (handoff.gotchas) {
            lines.push("## Gotchas / Watch Out For");
            lines.push(handoff.gotchas);
            lines.push("");
        }

        if (handoff.decisions.length > 0) {
            lines.push("## Related Decisions");
            lines.push(`Decision IDs: ${handoff.decisions.join(", ")}`);
            lines.push("");
        }

        if (handoff.blockers.length > 0) {
            lines.push("## Active Blockers");
            lines.push(`Blocker IDs: ${handoff.blockers.join(", ")}`);
            lines.push("");
        }

        lines.push("## Contact");
        lines.push(handoff.contact);

        return lines.join("\n");
    }

    function clearError() {
        setError(null);
    }

    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.handoffList(userId) });
        }
    }

    return {
        handoffs,
        loading,
        error,
        createHandoff,
        updateHandoff,
        acknowledgeHandoff,
        deleteHandoff,
        getHandoff,
        getHandoffsForTask,
        getPendingHandoffs,
        getReviewedHandoffs,
        getMyCreatedHandoffs,
        getHandoffsAssignedToMe,
        getRecentHandoffs,
        generateHandoffMarkdown,
        clearError,
        refresh,
    };
}
