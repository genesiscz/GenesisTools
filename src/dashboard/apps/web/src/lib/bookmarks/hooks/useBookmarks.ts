import type { BookmarkRow } from "../bookmarks.server";
import {
    useBookmarksQuery,
    useCreateBookmarkMutation,
    useDeleteBookmarkMutation,
    useFetchUrlMetadataMutation,
    useUpdateBookmarkMutation,
} from "./useBookmarksQueries";

export interface BookmarkInput {
    url: string;
    title: string;
    description: string;
    faviconUrl?: string;
    tags: string[];
}

export function useBookmarks(userId: string | null) {
    const query = useBookmarksQuery(userId);
    const createMut = useCreateBookmarkMutation();
    const updateMut = useUpdateBookmarkMutation();
    const deleteMut = useDeleteBookmarkMutation();
    const metaMut = useFetchUrlMetadataMutation();

    const bookmarks: BookmarkRow[] = query.data ?? [];
    const loading = query.isLoading;
    const initialized = !loading && query.data !== undefined;

    async function addBookmark(input: BookmarkInput): Promise<BookmarkRow | null> {
        if (!userId) {
            return null;
        }

        const now = new Date().toISOString();
        return createMut.mutateAsync({
            id: crypto.randomUUID(),
            userId,
            url: input.url,
            title: input.title,
            description: input.description,
            faviconUrl: input.faviconUrl ?? null,
            tags: input.tags,
            createdAt: now,
            updatedAt: now,
        });
    }

    async function editBookmark(
        id: string,
        patch: Partial<Pick<BookmarkRow, "title" | "description" | "faviconUrl" | "tags" | "url">>
    ): Promise<BookmarkRow | null> {
        if (!userId) {
            return null;
        }

        return updateMut.mutateAsync({ id, userId, patch });
    }

    async function removeBookmark(id: string): Promise<boolean> {
        if (!userId) {
            return false;
        }

        const result = await deleteMut.mutateAsync({ id, userId });
        return result.success;
    }

    async function previewUrl(url: string) {
        return metaMut.mutateAsync(url);
    }

    function getAllTags(): string[] {
        const tagSet = new Set<string>();
        for (const bm of bookmarks) {
            for (const tag of bm.tags) {
                tagSet.add(tag);
            }
        }
        return Array.from(tagSet).sort();
    }

    return {
        bookmarks,
        loading,
        initialized,
        error: query.error,
        addBookmark,
        editBookmark,
        removeBookmark,
        previewUrl,
        metaLoading: metaMut.isPending,
        getAllTags,
    };
}
