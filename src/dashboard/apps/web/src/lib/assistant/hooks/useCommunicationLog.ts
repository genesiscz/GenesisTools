/**
 * Communication Log Hook - Server-first with localStorage fallback
 *
 * Uses TanStack Query for server data with refetchOnWindowFocus.
 * Falls back to localStorage when server is unavailable.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import { useEffect, useMemo } from "react";
import { getAssistantStorageAdapter, initializeAssistantStorage } from "@/lib/assistant/lib/storage";
import type { CommunicationQueryOptions } from "@/lib/assistant/lib/storage/types";
import type { CommunicationEntry, CommunicationEntryInput, CommunicationEntryUpdate } from "@/lib/assistant/types";
import { generateCommunicationId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantCommunicationsQuery,
    useCreateAssistantCommunicationMutation,
    useDeleteAssistantCommunicationMutation,
    useUpdateAssistantCommunicationMutation,
} from "./useAssistantQueries";

/**
 * Communication log store state for fallback mode
 */
interface CommunicationStoreState {
    fallbackMode: boolean;
    fallbackEntries: CommunicationEntry[];
    error: string | null;
}

/**
 * Create the communication store (for fallback state only)
 */
export const communicationStore = new Store<CommunicationStoreState>({
    fallbackMode: false,
    fallbackEntries: [],
    error: null,
});

/**
 * Hook to manage communication log entries
 * Server-first with localStorage fallback
 */
export function useCommunicationLog(userId: string | null) {
    const state = useStore(communicationStore);
    const queryClient = useQueryClient();

    // Server queries
    const communicationsQuery = useAssistantCommunicationsQuery(userId);

    // Server mutations
    const createMutation = useCreateAssistantCommunicationMutation();
    const updateMutation = useUpdateAssistantCommunicationMutation();
    const deleteMutation = useDeleteAssistantCommunicationMutation();

    // Determine if we should use fallback mode
    const useFallback = state.fallbackMode || (communicationsQuery.isError && !communicationsQuery.data);

    // Initialize localStorage fallback if server fails
    useEffect(() => {
        if (!userId) {
            return;
        }

        if (communicationsQuery.isError && !state.fallbackMode) {
            const currentUserId = userId;

            async function loadFallback() {
                try {
                    const adapter = await initializeAssistantStorage();
                    const entries = await adapter.getCommunicationEntries(currentUserId);

                    communicationStore.setState((s) => ({
                        ...s,
                        fallbackMode: true,
                        fallbackEntries: entries,
                    }));
                } catch (err) {
                    communicationStore.setState((s) => ({
                        ...s,
                        error: err instanceof Error ? err.message : "Failed to load fallback",
                    }));
                }
            }

            loadFallback();
        }
    }, [userId, communicationsQuery.isError, state.fallbackMode]);

    // Convert server entries to app CommunicationEntry type
    const entries: CommunicationEntry[] = useMemo(() => {
        if (useFallback) {
            return state.fallbackEntries;
        }

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
    }, [useFallback, state.fallbackEntries, communicationsQuery.data]);

    // Loading state
    const loading = communicationsQuery.isLoading;
    const initialized = !loading && (communicationsQuery.data !== undefined || useFallback);

    /**
     * Create a new communication entry
     */
    async function createEntry(input: CommunicationEntryInput): Promise<CommunicationEntry | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const entryId = generateCommunicationId();

        if (useFallback) {
            try {
                const adapter = getAssistantStorageAdapter();
                return await adapter.createCommunicationEntry(input, userId);
            } catch (err) {
                communicationStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to create communication entry",
                }));
                return null;
            }
        }

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
            // Fall back to localStorage on error
            try {
                const adapter = await initializeAssistantStorage();
                return await adapter.createCommunicationEntry(input, userId);
            } catch {
                communicationStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to create communication entry",
                }));
                return null;
            }
        }
    }

    /**
     * Update an existing communication entry
     */
    async function updateEntry(id: string, updates: CommunicationEntryUpdate): Promise<CommunicationEntry | null> {
        if (!userId) {
            return null;
        }

        // Convert updates for server - use correct field names
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

        if (useFallback) {
            try {
                const adapter = getAssistantStorageAdapter();
                return await adapter.updateCommunicationEntry(id, updates);
            } catch (err) {
                communicationStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to update communication entry",
                }));
                return null;
            }
        }

        try {
            const result = await updateMutation.mutateAsync({ id, data: serverUpdates, userId });
            if (!result) {
                throw new Error("Failed to update communication entry");
            }

            // Return the updated entry
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
            // Fall back to localStorage
            try {
                const adapter = await initializeAssistantStorage();
                return await adapter.updateCommunicationEntry(id, updates);
            } catch {
                communicationStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to update communication entry",
                }));
                return null;
            }
        }
    }

    /**
     * Delete a communication entry
     */
    async function deleteEntry(id: string): Promise<boolean> {
        if (useFallback) {
            try {
                const adapter = getAssistantStorageAdapter();
                await adapter.deleteCommunicationEntry(id);
                return true;
            } catch (err) {
                communicationStore.setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : "Failed to delete communication entry",
                }));
                return false;
            }
        }

        try {
            const result = await deleteMutation.mutateAsync({ id, userId: userId! });
            return result.success;
        } catch (err) {
            communicationStore.setState((s) => ({
                ...s,
                error: err instanceof Error ? err.message : "Failed to delete communication entry",
            }));
            return false;
        }
    }

    /**
     * Get an entry by ID
     */
    function getEntry(id: string): CommunicationEntry | undefined {
        return entries.find((e) => e.id === id);
    }

    /**
     * Query entries with filters (falls back to local filtering)
     */
    async function queryEntries(options: CommunicationQueryOptions): Promise<CommunicationEntry[]> {
        if (!userId) {
            return [];
        }

        // For server mode, we filter locally since we have all entries
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

        // Sort by discussedAt descending
        filtered.sort((a, b) => b.discussedAt.getTime() - a.discussedAt.getTime());

        if (options.limit) {
            filtered = filtered.slice(0, options.limit);
        }

        return filtered;
    }

    /**
     * Get entries by source
     */
    function getBySource(source: CommunicationEntry["source"]): CommunicationEntry[] {
        return entries.filter((e) => e.source === source);
    }

    /**
     * Get entries by sentiment
     */
    function getBySentiment(sentiment: CommunicationEntry["sentiment"]): CommunicationEntry[] {
        return entries.filter((e) => e.sentiment === sentiment);
    }

    /**
     * Get entries related to a task
     */
    function getByTaskId(taskId: string): CommunicationEntry[] {
        return entries.filter((e) => e.relatedTaskIds.includes(taskId));
    }

    /**
     * Get entries with a specific tag
     */
    function getByTag(tag: string): CommunicationEntry[] {
        return entries.filter((e) => e.tags.includes(tag));
    }

    /**
     * Get all unique tags
     */
    function getAllTags(): string[] {
        const tagSet = new Set<string>();
        for (const entry of entries) {
            for (const tag of entry.tags) {
                tagSet.add(tag);
            }
        }
        return Array.from(tagSet).sort();
    }

    /**
     * Get recent entries (last 7 days)
     */
    function getRecentEntries(days = 7): CommunicationEntry[] {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        return entries.filter((e) => e.discussedAt >= cutoff);
    }

    /**
     * Clear error
     */
    function clearError() {
        communicationStore.setState((s) => ({ ...s, error: null }));
    }

    /**
     * Manual refresh
     */
    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.communicationList(userId) });
        }
    }

    return {
        // State
        entries,
        loading,
        error: state.error,
        initialized,

        // CRUD operations
        createEntry,
        updateEntry,
        deleteEntry,
        getEntry,
        queryEntries,

        // Filters
        getBySource,
        getBySentiment,
        getByTaskId,
        getByTag,
        getAllTags,
        getRecentEntries,

        // Utilities
        clearError,
        refresh,

        // Server status
        isServerMode: !useFallback,
    };
}
