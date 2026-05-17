import type { ReminderInfo } from "@genesiscz/darwinkit";

interface TodoListProps {
    reminders: ReminderInfo[];
    onComplete: (id: string) => void;
    onDelete: (id: string) => void;
}

function formatDue(due: string): { label: string; overdue: boolean } {
    const date = new Date(due);
    const overdue = date.getTime() < Date.now();
    const label = date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });

    return { label, overdue };
}

export function TodoList({ reminders, onComplete, onDelete }: TodoListProps) {
    if (reminders.length === 0) {
        return (
            <div className="py-8 text-center text-sm text-[var(--dd-text-muted)]">No todos. You're all caught up.</div>
        );
    }

    return (
        <ul className="flex flex-col gap-1">
            {reminders.map((reminder) => {
                const dueInfo = reminder.due_date ? formatDue(reminder.due_date) : null;

                return (
                    <li
                        key={reminder.identifier}
                        className="group flex items-center gap-3 rounded-md border border-transparent px-2 py-2 hover:border-[var(--dd-border)]"
                    >
                        <button
                            type="button"
                            aria-label="Complete todo"
                            onClick={() => onComplete(reminder.identifier)}
                            className="h-5 w-5 shrink-0 rounded-full border-2 border-[var(--dd-border)] transition-colors hover:border-[var(--dd-accent-from)]"
                        />
                        <span className="flex-1 truncate text-sm text-[var(--dd-text-primary)]">{reminder.title}</span>
                        {dueInfo ? (
                            <span
                                className={`shrink-0 text-xs ${
                                    dueInfo.overdue ? "text-amber-400" : "text-[var(--dd-text-muted)]"
                                }`}
                            >
                                {dueInfo.label}
                            </span>
                        ) : null}
                        <button
                            type="button"
                            aria-label="Delete todo"
                            onClick={() => onDelete(reminder.identifier)}
                            className="shrink-0 px-1 text-[var(--dd-text-muted)] opacity-0 transition-opacity hover:text-amber-400 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dd-accent-from)]"
                        >
                            ✕
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
