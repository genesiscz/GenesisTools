import type { TodoGroupBy, TodoStatusFilter, TodosResult } from "@app/dev-dashboard/lib/todos/types";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useMemo, useRef, useState } from "react";
import { AddTodoForm } from "@/components/todos/AddTodoForm";
import { BucketFilter } from "@/components/todos/BucketFilter";
import { GroupBySelect } from "@/components/todos/GroupBySelect";
import { StatusFilter } from "@/components/todos/StatusFilter";
import { TodoDeleteDialog } from "@/components/todos/TodoDeleteDialog";
import { TodoList } from "@/components/todos/TodoList";
import { fetchJson } from "@/lib/api";

const DEFAULT_LIST = "GenesisTools";

class PermissionError extends Error {}

async function fetchTodos(lists: string[], includeCompleted: boolean): Promise<TodosResult> {
    const params = new URLSearchParams({ lists: lists.join(",") });
    if (includeCompleted) {
        params.set("includeCompleted", "true");
    }

    const res = await fetch(`/api/todos?${params.toString()}`);

    if (res.status === 503) {
        throw new PermissionError("Reminders permission needed");
    }

    if (!res.ok) {
        throw new Error(`Failed to load todos: ${res.status}`);
    }

    return SafeJSON.parse(await res.text(), { strict: true }) as TodosResult;
}

function isPermissionError(error: unknown): error is PermissionError {
    return error instanceof PermissionError;
}

export function TodosRoute() {
    const [selectedLists, setSelectedLists] = useState<string[]>([DEFAULT_LIST]);
    const [groupBy, setGroupBy] = useState<TodoGroupBy>("date");
    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState<TodoStatusFilter>("active");
    const queryClient = useQueryClient();
    const latchedErrorRef = useRef<Error | null>(null);

    const includeCompleted = statusFilter !== "active";
    const listsKey = selectedLists.join(",");

    const todosQuery = useQuery({
        queryKey: ["todos", listsKey, includeCompleted],
        queryFn: () => fetchTodos(selectedLists, includeCompleted),
        refetchInterval: 10_000,
        retry: false,
        refetchOnWindowFocus: false,
    });

    if (todosQuery.error) {
        latchedErrorRef.current = todosQuery.error;
    } else if (todosQuery.isSuccess) {
        latchedErrorRef.current = null;
    }

    const latchedError = latchedErrorRef.current;

    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: ["todos"] });
    };

    const addTargetList = selectedLists[0] ?? DEFAULT_LIST;

    const addMutation = useMutation({
        mutationFn: (input: { title: string; due?: string; priority?: string }) =>
            fetchJson("/api/todos", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ ...input, listName: addTargetList }),
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
        onSuccess: () => {
            setDeleteTargetId(null);
            invalidate();
        },
    });

    const requestAccessMutation = useMutation({
        mutationFn: () =>
            fetchJson<{ authorized: boolean; status: string }>("/api/todos/request-access", {
                method: "POST",
            }),
        onSuccess: (result) => {
            if (result.authorized) {
                invalidate();
            }
        },
    });

    const lists = todosQuery.data?.lists ?? [];
    const reminders = todosQuery.data?.reminders ?? [];
    const filteredReminders = useMemo(() => {
        if (statusFilter === "done") {
            return reminders.filter((reminder) => reminder.is_completed);
        }

        if (statusFilter === "active") {
            return reminders.filter((reminder) => !reminder.is_completed);
        }

        return reminders;
    }, [reminders, statusFilter]);
    const showListName = selectedLists.length !== 1;
    const showInitialLoader = todosQuery.isPending && !latchedError;
    const deleteTarget = deleteTargetId
        ? (reminders.find((reminder) => reminder.identifier === deleteTargetId) ?? null)
        : null;

    if (latchedError && isPermissionError(latchedError)) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] flex-col items-center justify-center gap-4 px-4 text-center">
                <p className="dd-accent-text text-lg font-bold">Reminders permission needed</p>
                <p className="max-w-md text-sm text-[var(--dd-text-secondary)]">
                    macOS does not let you add apps manually here (no “+” button). Click below to show Apple’s
                    permission dialog — allow access for <strong className="text-[var(--dd-text-primary)]">bun</strong>
                    {requestAccessMutation.data?.status ? ` (status: ${requestAccessMutation.data.status})` : ""}.
                </p>
                <p className="max-w-md text-xs text-[var(--dd-text-secondary)] opacity-80">
                    If no dialog appears, the dashboard may be running in the background (launchd). Run{" "}
                    <code className="text-[var(--dd-accent)]">tools dev-dashboard ui up --foreground</code> in Terminal,
                    open Todos again, then click Allow.
                </p>
                <Button
                    type="button"
                    variant="default"
                    disabled={requestAccessMutation.isPending}
                    onClick={() => requestAccessMutation.mutate()}
                >
                    {requestAccessMutation.isPending ? "Waiting for macOS…" : "Allow Reminders access"}
                </Button>
                {requestAccessMutation.isError ? (
                    <p className="max-w-md text-sm text-[#f87171]">
                        {requestAccessMutation.error instanceof Error
                            ? requestAccessMutation.error.message
                            : String(requestAccessMutation.error)}
                    </p>
                ) : null}
            </div>
        );
    }

    if (latchedError && !isPermissionError(latchedError)) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] flex-col items-center justify-center gap-2 text-center">
                <p className="text-lg font-bold text-[#f87171]">Failed to load todos</p>
                <p className="max-w-sm text-sm text-[var(--dd-text-secondary)]">{latchedError.message}</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="dd-accent-text text-xl font-bold">Todos</h2>
                <div className="flex flex-wrap items-center gap-3">
                    <GroupBySelect value={groupBy} onChange={setGroupBy} />
                    <StatusFilter value={statusFilter} onChange={setStatusFilter} />
                    <BucketFilter
                        lists={lists}
                        selected={selectedLists}
                        onChange={setSelectedLists}
                        defaultList={DEFAULT_LIST}
                    />
                </div>
            </div>

            <div className="dd-panel flex flex-col gap-4 p-4">
                <AddTodoForm onAdd={(input) => addMutation.mutate(input)} pending={addMutation.isPending} />

                {showInitialLoader ? (
                    <div className="py-8 text-center text-sm text-[var(--dd-text-muted)]">Loading todos...</div>
                ) : (
                    <TodoList
                        reminders={filteredReminders}
                        statusFilter={statusFilter}
                        groupBy={groupBy}
                        showListName={showListName}
                        onComplete={(id) => completeMutation.mutate(id)}
                        onDelete={(id) => setDeleteTargetId(id)}
                    />
                )}
            </div>

            {deleteTarget ? (
                <TodoDeleteDialog
                    open
                    todoTitle={deleteTarget.title}
                    pending={deleteMutation.isPending}
                    onOpenChange={(open) => {
                        if (!open) {
                            setDeleteTargetId(null);
                        }
                    }}
                    onConfirm={() => deleteMutation.mutate(deleteTarget.identifier)}
                />
            ) : null}
        </div>
    );
}
