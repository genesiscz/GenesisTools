import { useMutation, useQuery } from "@tanstack/react-query";
import type { NewReadingHighlight, NewReadingItem } from "@/drizzle";
import { useInvalidateAndBroadcast } from "@/lib/sync/useBroadcastInvalidation";
import {
    createReadingHighlight,
    createReadingItem,
    deleteReadingHighlight,
    deleteReadingItem,
    listReadingHighlights,
    listReadingItems,
    updateReadingItem,
} from "../reading.server";
import { READING_SYNC_CHANNEL, readingKeys } from "../reading-keys";

const queryConfig = {
    staleTime: 30_000,
    refetchOnWindowFocus: true,
};

type ReadingItemPatch = Parameters<typeof updateReadingItem>[0]["data"]["patch"];

// ============================================
// Queries
// ============================================

export function useReadingItemsQuery(userId: string | null) {
    return useQuery({
        queryKey: readingKeys.list(userId ?? ""),
        queryFn: () => listReadingItems(),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useReadingHighlightsQuery(itemId: string | null) {
    return useQuery({
        queryKey: readingKeys.highlights(itemId ?? ""),
        queryFn: () => listReadingHighlights({ data: { itemId: itemId ?? "" } }),
        enabled: !!itemId,
        ...queryConfig,
    });
}

// ============================================
// Mutations — broadcast across tabs (criterion #6)
// ============================================

export function useCreateReadingItemMutation() {
    const invalidate = useInvalidateAndBroadcast(READING_SYNC_CHANNEL);

    return useMutation({
        mutationFn: (data: NewReadingItem) => createReadingItem({ data }),
        onSuccess: (result) => {
            invalidate(readingKeys.list(result.userId));
        },
    });
}

export function useUpdateReadingItemMutation() {
    const invalidate = useInvalidateAndBroadcast(READING_SYNC_CHANNEL);

    return useMutation({
        mutationFn: (d: { id: string; userId: string; patch: ReadingItemPatch }) =>
            updateReadingItem({ data: { id: d.id, patch: d.patch } }),
        onSuccess: (result) => {
            invalidate(readingKeys.list(result.userId));
        },
    });
}

export function useDeleteReadingItemMutation() {
    const invalidate = useInvalidateAndBroadcast(READING_SYNC_CHANNEL);

    return useMutation({
        mutationFn: (d: { id: string; userId: string }) => deleteReadingItem({ data: { id: d.id } }),
        onSuccess: (_result, variables) => {
            invalidate(readingKeys.list(variables.userId));
        },
    });
}

export function useCreateReadingHighlightMutation() {
    const invalidate = useInvalidateAndBroadcast(READING_SYNC_CHANNEL);

    return useMutation({
        mutationFn: (data: NewReadingHighlight) => createReadingHighlight({ data }),
        onSuccess: (result) => {
            invalidate(readingKeys.highlights(result.itemId));
        },
    });
}

export function useDeleteReadingHighlightMutation() {
    const invalidate = useInvalidateAndBroadcast(READING_SYNC_CHANNEL);

    return useMutation({
        mutationFn: (d: { id: string; itemId: string }) => deleteReadingHighlight({ data: { id: d.id } }),
        onSuccess: (_result, variables) => {
            invalidate(readingKeys.highlights(variables.itemId));
        },
    });
}
