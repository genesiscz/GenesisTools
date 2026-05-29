import { Button } from "@ui/components/button";
import { type FormEvent, useState } from "react";

interface AddTodoFormProps {
    onAdd: (input: { title: string; due?: string; priority?: string }) => void;
    pending: boolean;
}

const PRIORITY_OPTIONS = ["none", "low", "medium", "high"] as const;

function formatDateTimeLocal(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function defaultDueDatetimeLocal(): string {
    const due = new Date();
    due.setHours(due.getHours() + 1);
    return formatDateTimeLocal(due);
}

export function AddTodoForm({ onAdd, pending }: AddTodoFormProps) {
    const [title, setTitle] = useState("");
    const [due, setDue] = useState(defaultDueDatetimeLocal);
    const [priority, setPriority] = useState<string>("none");

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        const trimmed = title.trim();

        if (!trimmed || pending) {
            return;
        }

        onAdd({
            title: trimmed,
            due: due ? new Date(due).toISOString() : undefined,
            priority: priority === "none" ? undefined : priority,
        });
        setTitle("");
        setDue(defaultDueDatetimeLocal());
        setPriority("none");
    };

    return (
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
            <input
                type="text"
                aria-label="Todo title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Add a todo..."
                className="min-w-[12rem] flex-1 rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 text-sm text-[var(--dd-text-primary)] outline-none focus:border-[var(--dd-accent-from)]"
            />
            <input
                type="datetime-local"
                aria-label="Due date and time"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                className="rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 text-sm text-[var(--dd-text-secondary)] outline-none focus:border-[var(--dd-accent-from)]"
            />
            <select
                aria-label="Priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 text-sm text-[var(--dd-text-secondary)] outline-none focus:border-[var(--dd-accent-from)]"
            >
                {PRIORITY_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                        {opt}
                    </option>
                ))}
            </select>
            <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={pending || !title.trim()}
                className="dd-btn-accent shrink-0 hover:bg-transparent"
            >
                {pending ? "Adding..." : "Add"}
            </Button>
        </form>
    );
}
