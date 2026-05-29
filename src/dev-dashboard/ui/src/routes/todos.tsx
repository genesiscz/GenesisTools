import type { TodoGroupBy, TodoStatusFilter, TodosResult } from "@app/dev-dashboard/lib/todos/types";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useEffect, useMemo, useRef, useState } from "react";
import { AddTodoForm } from "@/components/todos/AddTodoForm";
import { BucketFilter } from "@/components/todos/BucketFilter";
import { EditTodoDialog, type EditTodoInput } from "@/components/todos/EditTodoDialog";
import { GroupBySelect } from "@/components/todos/GroupBySelect";
import { StatusFilter } from "@/components/todos/StatusFilter";
import { TodoDeleteDialog } from "@/components/todos/TodoDeleteDialog";
import { TodoList } from "@/components/todos/TodoList";
import { fetchJson } from "@/lib/api";

const DEFAULT_LIST = "GenesisTools";

class PermissionError extends Error {}

async function fetchTodos(listIds: string[], includeCompleted: boolean): Promise<TodosResult> {
    const params = new URLSearchParams();

    if (listIds.length > 0) {
        params.set("listIds", listIds.join(","));
    }

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
    const [selectedListIds, setSelectedListIds] = useState<string[]>([]);
    const [groupBy, setGroupBy] = useState<TodoGroupBy>("date");
    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
    const [editTargetId, setEditTargetId] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState<TodoStatusFilter>("active");
    const queryClient = useQueryClient();
    const latchedErrorRef = useRef<Error | null>(null);

    const includeCompleted = statusFilter !== "active";
    const listsKey = [...selectedListIds].sort().join(",");

    const todosQuery = useQuery({
        queryKey: ["todos", listsKey, includeCompleted],
        queryFn: () => fetchTodos(selectedListIds, includeCompleted),
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

    const lists = todosQuery.data?.lists ?? [];
    const reminders = todosQuery.data?.reminders ?? [];

    useEffect(() => {
        if (lists.length === 0 || selectedListIds.length > 0) {
            return;
        }

        const preferred = lists.find((list) => list.title === DEFAULT_LIST);

        if (preferred) {
            setSelectedListIds([preferred.identifier]);
            return;
        }

        if (lists[0]) {
            setSelectedListIds([lists[0].identifier]);
        }
    }, [lists, selectedListIds.length]);

    const addTargetList = useMemo(() => {
        const first = lists.find((list) => selectedListIds.includes(list.identifier));

        return first?.title ?? DEFAULT_LIST;
    }, [lists, selectedListIds]);

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

    const editMutation = useMutation({
        mutationFn: (input: EditTodoInput) =>
            fetchJson("/api/todos", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify(input),
            }),
        onSuccess: () => {
            setEditTargetId(null);
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

    const filteredReminders = useMemo(() => {
        if (statusFilter === "done") {
            return reminders.filter((reminder) => reminder.is_completed);
        }

        if (statusFilter === "active") {
            return reminders.filter((reminder) => !reminder.is_completed);
        }

        return reminders;
    }, [reminders, statusFilter]);
    const showListName = selectedListIds.length !== 1;
    const showInitialLoader = todosQuery.isPending && !latchedError;
    const deleteTarget = deleteTargetId
        ? (reminders.find((reminder) => reminder.identifier === deleteTargetId) ?? null)
        : null;
    const editTarget = editTargetId
        ? (reminders.find((reminder) => reminder.identifier === editTargetId) ?? null)
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
                        selectedIds={selectedListIds}
                        onChange={setSelectedListIds}
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
                        onEdit={(id) => setEditTargetId(id)}
                        onDelete={(id) => setDeleteTargetId(id)}
                    />
                )}
            </div>

            {editTarget ? (
                <EditTodoDialog
                    open
                    reminder={editTarget}
                    pending={editMutation.isPending}
                    onOpenChange={(open) => {
                        if (!open) {
                            setEditTargetId(null);
                        }
                    }}
                    onSave={(input) => editMutation.mutate(input)}
                />
            ) : null}

            {editMutation.isError ? (
                <p className="text-sm text-[#f87171]">
                    {editMutation.error instanceof Error ? editMutation.error.message : String(editMutation.error)}
                </p>
            ) : null}

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
