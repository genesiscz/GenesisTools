import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { addTodo, completeTodo, requestTodosAccess, todosListQuery } from "@/features/reminders-todos/queries";
import type { AddTodoInput } from "@/features/reminders-todos/types";

/**
 * Component-facing reminders-todos hooks (D32). Components import THESE — never raw `useQuery`/
 * `useMutation`. The query hook is a one-liner over the active client; the mutation hooks wrap
 * `useMutation` over the same client and invalidate the `["todos", "list"]` PREFIX on success so
 * BOTH the active and completed views refetch (mirrors `useMarkRead` invalidating `["qa", "log"]`).
 *
 * ► REFERENCE SHAPE: `useX = () => useQuery(xQuery(useDashboardClient()))`.
 */

export function useTodos(includeCompleted = false) {
    return useQuery(todosListQuery(useDashboardClient(), includeCompleted));
}

export function useAddTodo() {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: AddTodoInput) => addTodo(client, input),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["todos", "list"] });
        },
    });
}

export function useCompleteTodo() {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (reminderId: string) => completeTodo(client, reminderId),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["todos", "list"] });
        },
    });
}

export function useRequestTodosAccess() {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => requestTodosAccess(client),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["todos", "list"] });
        },
    });
}
