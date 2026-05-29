import type { TodoStatusFilter } from "@app/dev-dashboard/lib/todos/types";
import { SegmentedControl } from "@ui/components/segmented-control";

interface StatusFilterProps {
    value: TodoStatusFilter;
    onChange: (value: TodoStatusFilter) => void;
}

export function StatusFilter({ value, onChange }: StatusFilterProps) {
    return (
        <SegmentedControl
            tone="dd"
            aria-label="Todo status filter"
            className="w-auto"
            value={value}
            onValueChange={onChange}
            options={[
                { value: "active", label: "Active" },
                { value: "done", label: "Done" },
                { value: "all", label: "All" },
            ]}
        />
    );
}
