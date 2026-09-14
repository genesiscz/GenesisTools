import type { DashboardClient, TodosResult } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";
import type { AddTodoInput } from "@/features/reminders-todos/types";

/**
 * Reminders & Todos data layer (D32 + per-feature layout). Co-locates `todosKeys` and the
 * `todosListQuery` `queryOptions` factory over the injected `DashboardClient`, plus the thin
 * client-caller mutations (add / complete / requestAccess). Uses the typed `client.todos.*`
 * namespace (added to the contract) rather than the raw escape hatch — parity with `obsidian`/`qa`.
 *
 * Polling: reminders change on a user action (add/complete), not continuously, so a 15 s interval
 * keeps the active list fresh after off-app edits without hammering the device.
 */

export const todosKeys = {
    list: (includeCompleted: boolean) => ["todos", "list", includeCompleted] as const,
} as const;

export const TODOS_INTERVAL_MS = 15_000;

export function todosListQuery(client: DashboardClient, includeCompleted = false) {
    return queryOptions<TodosResult>({
        queryKey: todosKeys.list(includeCompleted),
        queryFn: () => client.todos.list([], includeCompleted),
        refetchInterval: TODOS_INTERVAL_MS,
    });
}

export function addTodo(client: DashboardClient, input: AddTodoInput) {
    return client.todos.add(input);
}

export function completeTodo(client: DashboardClient, reminderId: string) {
    return client.todos.complete(reminderId);
}

export function requestTodosAccess(client: DashboardClient) {
    return client.todos.requestAccess();
}
