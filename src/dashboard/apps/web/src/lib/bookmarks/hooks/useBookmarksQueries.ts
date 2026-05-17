import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NewBookmark } from "@/drizzle";
import { createBookmark, deleteBookmark, fetchUrlMetadata, listBookmarks, updateBookmark } from "../bookmarks.server";
import { bookmarkKeys } from "../bookmarks-keys";

const queryConfig = {
    staleTime: 30_000,
    refetchOnWindowFocus: true,
};

// ============================================
// Queries
// ============================================

export function useBookmarksQuery(userId: string | null) {
    return useQuery({
        queryKey: bookmarkKeys.list(userId ?? ""),
        queryFn: () => listBookmarks(),
        enabled: !!userId,
        ...queryConfig,
    });
}

// ============================================
// Mutations
// ============================================

export function useCreateBookmarkMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: NewBookmark) => createBookmark({ data }),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: bookmarkKeys.list(result.userId) });
        },
    });
}

export function useUpdateBookmarkMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (d: { id: string; userId: string; patch: Parameters<typeof updateBookmark>[0]["data"]["patch"] }) =>
            updateBookmark({ data: d }),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: bookmarkKeys.list(result.userId) });
        },
    });
}

export function useDeleteBookmarkMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (d: { id: string; userId: string }) => deleteBookmark({ data: d }),
        onSuccess: (_result, variables) => {
            queryClient.invalidateQueries({ queryKey: bookmarkKeys.list(variables.userId) });
        },
    });
}

export function useFetchUrlMetadataMutation() {
    return useMutation({
        mutationFn: (url: string) => fetchUrlMetadata({ data: { url } }),
    });
}
