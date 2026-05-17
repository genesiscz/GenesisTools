import { type FormEvent, useState } from "react";

interface AddTodoFormProps {
    onAdd: (input: { title: string; due?: string; priority?: string }) => void;
    pending: boolean;
}

const PRIORITY_OPTIONS = ["none", "low", "medium", "high"] as const;

export function AddTodoForm({ onAdd, pending }: AddTodoFormProps) {
    const [title, setTitle] = useState("");
    const [due, setDue] = useState("");
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
        setDue("");
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
            <button
                type="submit"
                disabled={pending || !title.trim()}
                className="rounded-md bg-[var(--dd-accent-gradient)] px-4 py-1.5 text-sm font-medium text-[var(--dd-bg-panel)] disabled:opacity-50"
            >
                {pending ? "Adding..." : "Add"}
            </button>
        </form>
    );
}
