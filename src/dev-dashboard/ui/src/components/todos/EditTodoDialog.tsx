import type { TodoPriority } from "@app/dev-dashboard/lib/todos/types";
import { reminderPriorityToTodo } from "@app/utils/macos/reminder-priority";
import type { ReminderInfo } from "@genesiscz/darwinkit";
import { Button } from "@ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@ui/components/dialog";
import { type FormEvent, useEffect, useState } from "react";

const PRIORITY_OPTIONS: TodoPriority[] = ["none", "low", "medium", "high"];

export interface EditTodoInput {
    reminderId: string;
    listIdentifier: string;
    title: string;
    notes?: string;
    due?: string | null;
    priority?: TodoPriority;
    url?: string;
}

interface Props {
    open: boolean;
    reminder: ReminderInfo | null;
    pending?: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (input: EditTodoInput) => void;
}

function formatDateTimeLocal(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");

    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function dueToDatetimeLocal(due?: string): string {
    if (!due) {
        return "";
    }

    const parsed = new Date(due);

    if (Number.isNaN(parsed.getTime())) {
        return "";
    }

    return formatDateTimeLocal(parsed);
}

export function EditTodoDialog({ open, reminder, pending, onOpenChange, onSave }: Props) {
    const [title, setTitle] = useState("");
    const [notes, setNotes] = useState("");
    const [due, setDue] = useState("");
    const [priority, setPriority] = useState<TodoPriority>("none");
    const [url, setUrl] = useState("");

    useEffect(() => {
        if (!open || !reminder) {
            return;
        }

        setTitle(reminder.title);
        setNotes(reminder.notes ?? "");
        setDue(dueToDatetimeLocal(reminder.due_date));
        setPriority(reminderPriorityToTodo(reminder.priority));
        setUrl(reminder.url ?? "");
    }, [open, reminder]);

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();

        if (!reminder || pending) {
            return;
        }

        const trimmedTitle = title.trim();

        if (!trimmedTitle) {
            return;
        }

        const trimmedNotes = notes.trim();
        const trimmedUrl = url.trim();

        onSave({
            reminderId: reminder.identifier,
            listIdentifier: reminder.list_identifier,
            title: trimmedTitle,
            notes: trimmedNotes || undefined,
            due: due ? new Date(due).toISOString() : null,
            priority: priority === "none" ? undefined : priority,
            url: trimmedUrl || undefined,
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="dd-panel max-w-lg border-white/10 bg-[#050505]/95">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--dd-text-muted)]">
                            Edit todo
                        </p>
                        <DialogTitle className="font-mono text-base">Update reminder</DialogTitle>
                        <DialogDescription className="font-mono text-xs text-[var(--dd-text-secondary)]">
                            {reminder?.list_title ?? "Reminders"}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-3 py-2">
                        <label className="flex flex-col gap-1">
                            <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                                Title
                            </span>
                            <input
                                type="text"
                                required
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                className="rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-2 text-sm text-[var(--dd-text-primary)] outline-none focus:border-[var(--dd-accent-from)]"
                            />
                        </label>

                        <label className="flex flex-col gap-1">
                            <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                                Notes
                            </span>
                            <textarea
                                rows={3}
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                placeholder="Optional"
                                className="resize-y rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-2 text-sm text-[var(--dd-text-primary)] outline-none focus:border-[var(--dd-accent-from)]"
                            />
                        </label>

                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="flex flex-col gap-1">
                                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                                    Due
                                </span>
                                <input
                                    type="datetime-local"
                                    value={due}
                                    onChange={(e) => setDue(e.target.value)}
                                    className="rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-2 text-sm text-[var(--dd-text-secondary)] outline-none focus:border-[var(--dd-accent-from)]"
                                />
                            </label>

                            <label className="flex flex-col gap-1">
                                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                                    Priority
                                </span>
                                <select
                                    value={priority}
                                    onChange={(e) => setPriority(e.target.value as TodoPriority)}
                                    className="rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-2 text-sm text-[var(--dd-text-secondary)] outline-none focus:border-[var(--dd-accent-from)]"
                                >
                                    {PRIORITY_OPTIONS.map((opt) => (
                                        <option key={opt} value={opt}>
                                            {opt}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </div>

                        <label className="flex flex-col gap-1">
                            <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                                URL
                            </span>
                            <input
                                type="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://"
                                className="rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-2 text-sm text-[var(--dd-text-primary)] outline-none focus:border-[var(--dd-accent-from)]"
                            />
                        </label>
                    </div>

                    <DialogFooter className="flex-col gap-2 sm:flex-col">
                        <Button
                            type="submit"
                            variant="default"
                            disabled={pending || !title.trim()}
                            className="w-full font-mono text-xs"
                        >
                            {pending ? "Saving…" : "Save changes"}
                        </Button>
                        <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
