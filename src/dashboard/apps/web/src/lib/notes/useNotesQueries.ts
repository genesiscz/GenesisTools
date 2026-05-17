import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NewNote } from "@/drizzle";
import { createNote, deleteNote, listNotes, updateNote } from "./notes.server";
import { notesKeys } from "./notes-keys";

const queryConfig = {
    staleTime: 30_000,
    refetchOnWindowFocus: true,
};

export function useNotesQuery(userId: string | null) {
    return useQuery({
        queryKey: notesKeys.list(userId ?? ""),
        queryFn: () => listNotes(),
        enabled: !!userId,
        ...queryConfig,
    });
}

export function useCreateNoteMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (data: { userId: string; title: string; body?: string; tags?: string[]; pinned?: number }) =>
            createNote({ data }),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: notesKeys.list(result.userId) });
        },
    });
}

export function useUpdateNoteMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            id,
            patch,
        }: {
            id: string;
            patch: Partial<Pick<NewNote, "title" | "body" | "tags" | "pinned">>;
        }) => updateNote({ data: { id, patch } }),
        onSuccess: (result) => {
            queryClient.setQueryData(notesKeys.detail(result.id), result);
            queryClient.invalidateQueries({ queryKey: notesKeys.list(result.userId) });
        },
    });
}

export function useDeleteNoteMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({ id }: { id: string; userId: string }) => deleteNote({ data: { id } }),
        onSuccess: (_, { userId }) => {
            queryClient.invalidateQueries({ queryKey: notesKeys.list(userId) });
        },
    });
}
