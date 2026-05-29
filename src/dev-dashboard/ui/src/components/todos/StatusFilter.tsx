import type { TodoStatusFilter } from "@app/dev-dashboard/lib/todos/types";

const FILTERS: { value: TodoStatusFilter; label: string }[] = [
    { value: "active", label: "Active" },
    { value: "done", label: "Done" },
    { value: "all", label: "All" },
];

interface StatusFilterProps {
    value: TodoStatusFilter;
    onChange: (value: TodoStatusFilter) => void;
}

export function StatusFilter({ value, onChange }: StatusFilterProps) {
    return (
        <div className="flex gap-1" role="group" aria-label="Todo status filter">
            {FILTERS.map((filter) => {
                const active = value === filter.value;

                return (
                    <button
                        key={filter.value}
                        type="button"
                        onClick={() => onChange(filter.value)}
                        className="dd-tab"
                        style={
                            active
                                ? { color: "#06120d", background: "var(--dd-accent-from)", fontWeight: 700 }
                                : undefined
                        }
                        aria-pressed={active}
                    >
                        {filter.label}
                    </button>
                );
            })}
        </div>
    );
}
