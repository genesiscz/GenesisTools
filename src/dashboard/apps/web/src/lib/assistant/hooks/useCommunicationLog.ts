import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import { useMemo } from "react";
import type { CommunicationEntry, CommunicationEntryInput, CommunicationEntryUpdate } from "@/lib/assistant/types";
import { generateCommunicationId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantCommunicationsQuery,
    useCreateAssistantCommunicationMutation,
    useDeleteAssistantCommunicationMutation,
    useUpdateAssistantCommunicationMutation,
} from "./useAssistantQueries";

interface CommunicationStoreState {
    error: string | null;
}

export const communicationStore = new Store<CommunicationStoreState>({
    error: null,
});

export function useCommunicationLog(userId: string | null) {
    const state = useStore(communicationStore);
    const queryClient = useQueryClient();

    const communicationsQuery = useAssistantCommunicationsQuery(userId);

    const createMutation = useCreateAssistantCommunicationMutation();
    const updateMutation = useUpdateAssistantCommunicationMutation();
    const deleteMutation = useDeleteAssistantCommunicationMutation();

    const entries: CommunicationEntry[] = useMemo(() => {
        return (communicationsQuery.data ?? []).map((e) => ({
            id: e.id,
            userId: e.userId,
            source: e.source as CommunicationEntry["source"],
            title: e.title,
            content: e.content,
            sourceUrl: e.sourceUrl ?? undefined,
            sentiment: e.sentiment as CommunicationEntry["sentiment"],
            relatedTaskIds: (e.relatedTaskIds as string[]) ?? [],
            tags: (e.tags as string[]) ?? [],
            discussedAt: new Date(e.discussedAt),
            createdAt: new Date(e.createdAt),
            updatedAt: new Date(e.updatedAt),
        }));
    }, [communicationsQuery.data]);

    const loading = communicationsQuery.isLoading;
    const initialized = !loading && communicationsQuery.data !== undefined;

    async function createEntry(input: CommunicationEntryInput): Promise<CommunicationEntry | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const entryId = generateCommunicationId();

        try {
            const result = await createMutation.mutateAsync({
                id: entryId,
                userId,
                source: input.source,
                title: input.title,
                content: input.content,
                sourceUrl: input.sourceUrl ?? null,
                sentiment: input.sentiment ?? "context",
                relatedTaskIds: input.relatedTaskIds ?? [],
                tags: input.tags ?? [],
                discussedAt: (input.discussedAt ?? now).toISOString(),
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            });

            if (!result) {
                throw new Error("Failed to create communication entry");
            }

            return {
                id: result.id,
                userId,
                source: input.source,
                title: input.title,
                content: input.content,
                sourceUrl: input.sourceUrl,
                sentiment: input.sentiment ?? "context",
                relatedTaskIds: input.relatedTaskIds ?? [],
                tags: input.tags ?? [],
                discussedAt: input.discussedAt ?? now,
                createdAt: now,
                updatedAt: now,
            };
        } catch (err) {
            communicationStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to create communication entry",
            }));
            return null;
        }
    }

    async function updateEntry(id: string, updates: CommunicationEntryUpdate): Promise<CommunicationEntry | null> {
        if (!userId) {
            return null;
        }

        const serverUpdates: Record<string, unknown> = {};
        if (updates.title !== undefined) {
            serverUpdates.title = updates.title;
        }
        if (updates.content !== undefined) {
            serverUpdates.content = updates.content;
        }
        if (updates.sourceUrl !== undefined) {
            serverUpdates.sourceUrl = updates.sourceUrl;
        }
        if (updates.sentiment !== undefined) {
            serverUpdates.sentiment = updates.sentiment;
        }
        if (updates.relatedTaskIds !== undefined) {
            serverUpdates.relatedTaskIds = updates.relatedTaskIds;
        }
        if (updates.tags !== undefined) {
            serverUpdates.tags = updates.tags;
        }
        if (updates.discussedAt !== undefined) {
            serverUpdates.discussedAt = updates.discussedAt.toISOString();
        }

        try {
            const result = await updateMutation.mutateAsync({ id, data: serverUpdates, userId });
            if (!result) {
                throw new Error("Failed to update communication entry");
            }

            const existingEntry = entries.find((e) => e.id === id);
            if (!existingEntry) {
                return null;
            }

            return {
                ...existingEntry,
                ...updates,
                updatedAt: new Date(),
            };
        } catch (err) {
            communicationStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to update communication entry",
            }));
            return null;
        }
    }

    async function deleteEntry(id: string): Promise<boolean> {
        if (!userId) {
            return false;
        }

        try {
            const result = await deleteMutation.mutateAsync({ id, userId });
            return result.success;
        } catch (err) {
            communicationStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to delete communication entry",
            }));
            return false;
        }
    }

    function getEntry(id: string): CommunicationEntry | undefined {
        return entries.find((e) => e.id === id);
    }

    interface CommunicationQueryOptions {
        source?: CommunicationEntry["source"];
        sentiment?: CommunicationEntry["sentiment"];
        relatedTaskId?: string;
        tags?: string[];
        startDate?: Date;
        endDate?: Date;
        limit?: number;
    }

    function queryEntries(options: CommunicationQueryOptions): CommunicationEntry[] {
        let filtered = [...entries];

        if (options.source) {
            filtered = filtered.filter((e) => e.source === options.source);
        }
        if (options.sentiment) {
            filtered = filtered.filter((e) => e.sentiment === options.sentiment);
        }
        if (options.relatedTaskId) {
            filtered = filtered.filter((e) => e.relatedTaskIds.includes(options.relatedTaskId!));
        }
        if (options.tags && options.tags.length > 0) {
            filtered = filtered.filter((e) => options.tags?.some((tag) => e.tags.includes(tag)));
        }
        if (options.startDate) {
            filtered = filtered.filter((e) => e.discussedAt >= options.startDate!);
        }
        if (options.endDate) {
            filtered = filtered.filter((e) => e.discussedAt <= options.endDate!);
        }

        filtered.sort((a, b) => b.discussedAt.getTime() - a.discussedAt.getTime());

        if (options.limit) {
            filtered = filtered.slice(0, options.limit);
        }

        return filtered;
    }

    function getBySource(source: CommunicationEntry["source"]): CommunicationEntry[] {
        return entries.filter((e) => e.source === source);
    }

    function getBySentiment(sentiment: CommunicationEntry["sentiment"]): CommunicationEntry[] {
        return entries.filter((e) => e.sentiment === sentiment);
    }

    function getByTaskId(taskId: string): CommunicationEntry[] {
        return entries.filter((e) => e.relatedTaskIds.includes(taskId));
    }

    function getByTag(tag: string): CommunicationEntry[] {
        return entries.filter((e) => e.tags.includes(tag));
    }

    function getAllTags(): string[] {
        const tagSet = new Set<string>();
        for (const entry of entries) {
            for (const tag of entry.tags) {
                tagSet.add(tag);
            }
        }
        return Array.from(tagSet).sort();
    }

    function getRecentEntries(days = 7): CommunicationEntry[] {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        return entries.filter((e) => e.discussedAt >= cutoff);
    }

    function clearError() {
        communicationStore.setState((s) => ({ ...s, error: null }));
    }

    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.communicationList(userId) });
        }
    }

    return {
        entries,
        loading,
        error: state.error,
        initialized,
        createEntry,
        updateEntry,
        deleteEntry,
        getEntry,
        queryEntries,
        getBySource,
        getBySentiment,
        getByTaskId,
        getByTag,
        getAllTags,
        getRecentEntries,
        clearError,
        refresh,
    };
}
