import type { TodoGroupBy } from "@app/dev-dashboard/lib/todos/types";

const OPTIONS: { value: TodoGroupBy; label: string }[] = [
    { value: "date", label: "Date" },
    { value: "date-priority", label: "Date + priority" },
    { value: "priority", label: "Priority" },
    { value: "bucket", label: "Bucket" },
];

interface GroupBySelectProps {
    value: TodoGroupBy;
    onChange: (value: TodoGroupBy) => void;
}

export function GroupBySelect({ value, onChange }: GroupBySelectProps) {
    return (
        <label className="flex items-center gap-2 text-xs text-[var(--dd-text-muted)]">
            <span className="font-mono uppercase tracking-wider">Group by</span>
            <select
                aria-label="Group todos by"
                value={value}
                onChange={(e) => onChange(e.target.value as TodoGroupBy)}
                className="rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-2 py-1.5 text-sm text-[var(--dd-text-primary)] outline-none focus:border-[var(--dd-accent-from)]"
            >
                {OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                        {opt.label}
                    </option>
                ))}
            </select>
        </label>
    );
}
