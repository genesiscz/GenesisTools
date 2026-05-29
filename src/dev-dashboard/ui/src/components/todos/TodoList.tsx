import type { TodoGroupBy, TodoStatusFilter } from "@app/dev-dashboard/lib/todos/types";
import { groupReminders } from "@app/utils/grouping/reminder-groups";
import {
    formatReminderDue,
    isReminderOverdue,
    notesPreview,
    priorityLabel,
    reminderDetailFields,
} from "@app/utils/macos/reminder-display";
import type { ReminderInfo } from "@genesiscz/darwinkit";
import { IconButton } from "@ui/components/icon-button";
import { useState } from "react";

interface TodoListProps {
    reminders: ReminderInfo[];
    statusFilter: TodoStatusFilter;
    groupBy: TodoGroupBy;
    showListName: boolean;
    onComplete: (id: string) => void;
    onEdit: (id: string) => void;
    onDelete: (id: string) => void;
}

function emptyMessage(statusFilter: TodoStatusFilter): string {
    if (statusFilter === "done") {
        return "No completed todos.";
    }

    if (statusFilter === "all") {
        return "No todos in selected buckets.";
    }

    return "No todos. You're all caught up.";
}

function TodoRow({
    reminder,
    showListName,
    expanded,
    onToggleExpand,
    onComplete,
    onEdit,
    onDelete,
}: {
    reminder: ReminderInfo;
    showListName: boolean;
    expanded: boolean;
    onToggleExpand: () => void;
    onComplete: (id: string) => void;
    onEdit: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const completed = reminder.is_completed;
    const dueLabel = formatReminderDue(reminder.due_date);
    const overdue = isReminderOverdue(reminder.due_date, completed);
    const preview = notesPreview(reminder.notes);
    const priority = priorityLabel(reminder.priority);
    const showPriority = reminder.priority !== 0;
    const detailFields = reminderDetailFields(reminder);

    return (
        <li className="rounded-md border border-transparent transition-colors hover:border-[var(--dd-border)]">
            <div className="group flex items-start gap-2 px-2 py-2">
                <IconButton
                    type="button"
                    variant="ghost"
                    size="icon"
                    tooltip={expanded ? "Collapse details" : "Expand details"}
                    aria-expanded={expanded}
                    onClick={onToggleExpand}
                    className="mt-0.5 h-auto w-auto shrink-0 px-1 text-[var(--dd-text-muted)] transition-transform hover:text-[var(--dd-accent-from)]"
                    style={{ transform: expanded ? "rotate(90deg)" : undefined }}
                >
                    ▸
                </IconButton>

                {completed ? (
                    <span
                        aria-hidden
                        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-[var(--dd-accent-from)] bg-[var(--dd-accent-from)]/20 text-xs text-[var(--dd-accent-from)]"
                    >
                        ✓
                    </span>
                ) : (
                    <IconButton
                        type="button"
                        variant="ghost"
                        size="icon"
                        tooltip="Complete todo"
                        onClick={() => onComplete(reminder.identifier)}
                        className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-[var(--dd-border)] p-0 transition-colors hover:border-[var(--dd-accent-from)] hover:bg-transparent"
                    />
                )}

                <button
                    type="button"
                    onClick={onToggleExpand}
                    className="min-w-0 flex-1 cursor-pointer text-left transition-colors hover:text-[var(--dd-text-primary)]"
                >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span
                            className={`text-sm font-medium ${
                                completed ? "text-[var(--dd-text-muted)] line-through" : "text-[var(--dd-text-primary)]"
                            }`}
                        >
                            {reminder.title}
                        </span>
                        {reminder.is_flagged ? (
                            <span className="text-[10px] text-amber-400" title="Flagged">
                                ⚑
                            </span>
                        ) : null}
                    </div>

                    {preview ? (
                        <p className="mt-0.5 line-clamp-1 text-xs text-[var(--dd-text-secondary)]">{preview}</p>
                    ) : null}

                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-mono uppercase tracking-wide">
                        {showListName ? (
                            <span className="rounded border border-[var(--dd-border)] px-1.5 py-0.5 text-[var(--dd-text-muted)]">
                                {reminder.list_title}
                            </span>
                        ) : null}
                        {showPriority ? <span className="text-[var(--dd-accent-from)]">{priority}</span> : null}
                        {dueLabel ? (
                            <span className={overdue ? "text-amber-400" : "text-[var(--dd-text-muted)]"}>
                                {dueLabel}
                            </span>
                        ) : null}
                        {reminder.url ? <span className="text-[var(--dd-text-muted)]">Link</span> : null}
                        {reminder.has_alarms ? <span className="text-[var(--dd-text-muted)]">Alarm</span> : null}
                    </div>
                </button>

                <IconButton
                    type="button"
                    variant="ghost"
                    size="icon"
                    tooltip="Edit todo"
                    onClick={() => onEdit(reminder.identifier)}
                    className="h-auto w-auto shrink-0 px-1 text-[var(--dd-text-muted)] opacity-0 transition-opacity hover:bg-transparent hover:text-[var(--dd-accent-from)] group-hover:opacity-100 focus-visible:opacity-100"
                >
                    ✎
                </IconButton>

                <IconButton
                    type="button"
                    variant="ghost"
                    size="icon"
                    tooltip="Delete todo"
                    onClick={() => onDelete(reminder.identifier)}
                    className="h-auto w-auto shrink-0 px-1 text-[var(--dd-text-muted)] opacity-0 transition-opacity hover:bg-transparent hover:text-amber-400 group-hover:opacity-100 focus-visible:opacity-100"
                >
                    ✕
                </IconButton>
            </div>

            {expanded ? (
                <div className="border-t border-[var(--dd-border)]/60 bg-[var(--dd-bg-panel)]/50 px-3 py-3 pl-11">
                    <div className="mb-3 flex justify-end">
                        <button
                            type="button"
                            onClick={() => onEdit(reminder.identifier)}
                            className="dd-accent-text cursor-pointer font-mono text-[10px] uppercase tracking-wider transition-opacity hover:opacity-80"
                        >
                            Edit title & notes
                        </button>
                    </div>
                    <dl className="grid gap-2 text-xs">
                        {detailFields.map((field) => (
                            <div key={`${field.label}-${field.value.slice(0, 24)}`} className="grid gap-0.5">
                                <dt className="font-mono uppercase tracking-wider text-[var(--dd-text-muted)]">
                                    {field.label}
                                </dt>
                                <dd className="whitespace-pre-wrap break-words text-[var(--dd-text-secondary)]">
                                    {field.label === "URL" ? (
                                        <a
                                            href={field.value}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-[var(--dd-accent-from)] underline-offset-2 hover:underline"
                                        >
                                            {field.value}
                                        </a>
                                    ) : (
                                        field.value
                                    )}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
            ) : null}
        </li>
    );
}

export function TodoList({
    reminders,
    statusFilter,
    groupBy,
    showListName,
    onComplete,
    onEdit,
    onDelete,
}: TodoListProps) {
    const [expandedId, setExpandedId] = useState<string | null>(null);

    if (reminders.length === 0) {
        return <div className="py-8 text-center text-sm text-[var(--dd-text-muted)]">{emptyMessage(statusFilter)}</div>;
    }

    const groups = groupReminders(reminders, groupBy);

    return (
        <div className="flex flex-col gap-4">
            {groups.map((group) => (
                <section key={group.key} aria-labelledby={`todo-group-${group.key}`}>
                    <h3
                        id={`todo-group-${group.key}`}
                        className="dd-accent-text mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.18em]"
                    >
                        {group.label}
                        <span className="ml-2 text-[var(--dd-text-muted)]">({group.items.length})</span>
                    </h3>
                    <ul className="flex flex-col gap-1">
                        {group.items.map((reminder) => (
                            <TodoRow
                                key={reminder.identifier}
                                reminder={reminder}
                                showListName={showListName}
                                expanded={expandedId === reminder.identifier}
                                onToggleExpand={() =>
                                    setExpandedId((current) =>
                                        current === reminder.identifier ? null : reminder.identifier
                                    )
                                }
                                onComplete={onComplete}
                                onEdit={onEdit}
                                onDelete={onDelete}
                            />
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}
