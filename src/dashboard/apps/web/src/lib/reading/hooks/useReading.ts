import type { ReadingItemRow } from "../reading.server";
import {
    useCreateReadingItemMutation,
    useDeleteReadingItemMutation,
    useReadingItemsQuery,
    useUpdateReadingItemMutation,
} from "./useReadingQueries";

export type ReadingStatus = "to_read" | "reading" | "done";
export type ReadingType = "book" | "article" | "paper";

export interface ReadingItemInput {
    title: string;
    author: string;
    type: ReadingType;
    url?: string;
    coverUrl?: string;
    totalPages: number;
    tags: string[];
}

export function useReading(userId: string | null) {
    const query = useReadingItemsQuery(userId);
    const createMut = useCreateReadingItemMutation();
    const updateMut = useUpdateReadingItemMutation();
    const deleteMut = useDeleteReadingItemMutation();

    const items: ReadingItemRow[] = query.data ?? [];
    const loading = query.isLoading;
    const initialized = !loading && query.data !== undefined;

    async function addItem(input: ReadingItemInput): Promise<ReadingItemRow | null> {
        if (!userId) {
            return null;
        }

        const now = new Date().toISOString();
        return createMut.mutateAsync({
            id: crypto.randomUUID(),
            userId,
            title: input.title,
            author: input.author,
            type: input.type,
            url: input.url ?? null,
            coverUrl: input.coverUrl ?? null,
            status: "to_read",
            currentPage: 0,
            totalPages: input.totalPages,
            rating: 0,
            tags: input.tags,
            createdAt: now,
            updatedAt: now,
            metadataJson: "{}",
        });
    }

    async function setStatus(id: string, status: ReadingStatus): Promise<ReadingItemRow | null> {
        if (!userId) {
            return null;
        }

        return updateMut.mutateAsync({ id, userId, patch: { status } });
    }

    async function setCurrentPage(id: string, currentPage: number): Promise<ReadingItemRow | null> {
        if (!userId) {
            return null;
        }

        return updateMut.mutateAsync({ id, userId, patch: { currentPage: Math.max(0, currentPage) } });
    }

    async function setRating(id: string, rating: number): Promise<ReadingItemRow | null> {
        if (!userId) {
            return null;
        }

        return updateMut.mutateAsync({ id, userId, patch: { rating: Math.min(5, Math.max(0, rating)) } });
    }

    async function removeItem(id: string): Promise<boolean> {
        if (!userId) {
            return false;
        }

        const result = await deleteMut.mutateAsync({ id, userId });
        return result.success;
    }

    function getAllTags(): string[] {
        const tagSet = new Set<string>();
        for (const item of items) {
            for (const tag of item.tags) {
                tagSet.add(tag);
            }
        }
        return Array.from(tagSet).sort();
    }

    return {
        items,
        loading,
        initialized,
        error: query.error,
        addItem,
        setStatus,
        setCurrentPage,
        setRating,
        removeItem,
        getAllTags,
    };
}
