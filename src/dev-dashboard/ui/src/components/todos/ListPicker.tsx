import type { ReminderListInfo } from "@genesiscz/darwinkit";

interface ListPickerProps {
    lists: ReminderListInfo[];
    value: string;
    onChange: (name: string) => void;
}

export function ListPicker({ lists, value, onChange }: ListPickerProps) {
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 text-sm text-[var(--dd-text-primary)] outline-none focus:border-[var(--dd-accent-from)]"
        >
            {lists.length === 0 ? (
                <option value={value}>{value}</option>
            ) : (
                lists.map((list) => (
                    <option key={list.identifier} value={list.title}>
                        {list.title}
                    </option>
                ))
            )}
        </select>
    );
}
