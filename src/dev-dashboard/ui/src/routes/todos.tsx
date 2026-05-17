import type { TodosResult } from "@app/dev-dashboard/lib/todos/types";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AddTodoForm } from "@/components/todos/AddTodoForm";
import { ListPicker } from "@/components/todos/ListPicker";
import { TodoList } from "@/components/todos/TodoList";
import { fetchJson } from "@/lib/api";

const DEFAULT_LIST = "GenesisTools";

class PermissionError extends Error {}

async function fetchTodos(list: string): Promise<TodosResult> {
    const res = await fetch(`/api/todos?list=${encodeURIComponent(list)}`);

    if (res.status === 503) {
        throw new PermissionError("Reminders permission needed");
    }

    if (!res.ok) {
        throw new Error(`Failed to load todos: ${res.status}`);
    }

    return SafeJSON.parse(await res.text(), { strict: true }) as TodosResult;
}

export function TodosRoute() {
    const [currentList, setCurrentList] = useState(DEFAULT_LIST);
    const queryClient = useQueryClient();

    const todosQuery = useQuery({
        queryKey: ["todos", currentList],
        queryFn: () => fetchTodos(currentList),
        refetchInterval: 10000,
        retry: false,
    });

    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: ["todos"] });
    };

    const addMutation = useMutation({
        mutationFn: (input: { title: string; due?: string; priority?: string }) =>
            fetchJson("/api/todos", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ ...input, listName: currentList }),
            }),
        onSuccess: invalidate,
    });

    const completeMutation = useMutation({
        mutationFn: (reminderId: string) =>
            fetchJson("/api/todos/complete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ reminderId }),
            }),
        onSuccess: invalidate,
    });

    const deleteMutation = useMutation({
        mutationFn: (reminderId: string) =>
            fetchJson("/api/todos", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ reminderId }),
            }),
        onSuccess: invalidate,
    });

    if (todosQuery.error instanceof PermissionError) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] flex-col items-center justify-center gap-2 text-center">
                <p className="dd-accent-text text-lg font-bold">Reminders permission needed</p>
                <p className="max-w-sm text-sm text-[var(--dd-text-secondary)]">
                    Grant access in System Settings → Privacy & Security → Reminders, then reload.
                </p>
            </div>
        );
    }

    if (todosQuery.isError && !(todosQuery.error instanceof PermissionError)) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] flex-col items-center justify-center gap-2 text-center">
                <p className="text-lg font-bold text-[#f87171]">Failed to load todos</p>
                <p className="max-w-sm text-sm text-[var(--dd-text-secondary)]">
                    {todosQuery.error instanceof Error ? todosQuery.error.message : String(todosQuery.error)}
                </p>
            </div>
        );
    }

    const lists = todosQuery.data?.lists ?? [];
    const reminders = todosQuery.data?.reminders ?? [];

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="dd-accent-text text-xl font-bold">Todos</h2>
                <ListPicker lists={lists} value={currentList} onChange={setCurrentList} />
            </div>

            <div className="dd-panel flex flex-col gap-4 p-4">
                <AddTodoForm onAdd={(input) => addMutation.mutate(input)} pending={addMutation.isPending} />

                {todosQuery.isLoading ? (
                    <div className="py-8 text-center text-sm text-[var(--dd-text-muted)]">Loading todos...</div>
                ) : (
                    <TodoList
                        reminders={reminders}
                        onComplete={(id) => completeMutation.mutate(id)}
                        onDelete={(id) => deleteMutation.mutate(id)}
                    />
                )}
            </div>
        </div>
    );
}
