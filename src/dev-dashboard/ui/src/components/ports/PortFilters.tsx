import type { PortFilterId, PortSortDir, PortSortKey } from "@app/dev-dashboard/lib/ports/classify";

const FILTERS: { id: PortFilterId; label: string }[] = [
    { id: "all", label: "All" },
    { id: "web", label: "Web" },
    { id: "apis", label: "Apis" },
    { id: "genesis-tools", label: "GenesisTools" },
];

const SORTS: { id: PortSortKey; label: string }[] = [
    { id: "age", label: "Age" },
    { id: "name", label: "Name" },
    { id: "port", label: "Port" },
];

interface PortFiltersProps {
    selected: PortFilterId[];
    onChange: (next: PortFilterId[]) => void;
    sortKey: PortSortKey;
    sortDir: PortSortDir;
    onSortKey: (key: PortSortKey) => void;
    onSortDir: (dir: PortSortDir) => void;
}

/**
 * Multiselect filters. Selecting All clears other chips; selecting a kind removes All.
 * Sort: click sets key (defaults to asc); click same key again OR double-click toggles dir.
 */
export function PortFilters({ selected, onChange, sortKey, sortDir, onSortKey, onSortDir }: PortFiltersProps) {
    const toggleFilter = (id: PortFilterId) => {
        if (id === "all") {
            onChange(["all"]);
            return;
        }

        const withoutAll = selected.filter((s) => s !== "all");
        if (withoutAll.includes(id)) {
            const next = withoutAll.filter((s) => s !== id);
            onChange(next.length === 0 ? ["all"] : next);
            return;
        }

        onChange([...withoutAll, id]);
    };

    const handleSortClick = (key: PortSortKey) => {
        if (key === sortKey) {
            onSortDir(sortDir === "asc" ? "desc" : "asc");
            return;
        }

        onSortKey(key);
        onSortDir(key === "age" ? "asc" : "asc");
    };

    const handleSortDblClick = (key: PortSortKey) => {
        if (key !== sortKey) {
            onSortKey(key);
        }
        onSortDir(sortDir === "asc" ? "desc" : "asc");
    };

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1">
                {FILTERS.map((f) => {
                    const active = selected.includes(f.id) || (f.id === "all" && selected.length === 0);
                    return (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => toggleFilter(f.id)}
                            className={`rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors ${
                                active
                                    ? "border-[var(--dd-accent)] bg-[var(--dd-accent)]/15 text-[var(--dd-accent)]"
                                    : "border-[var(--dd-border)] text-[var(--dd-text-secondary)] hover:border-[var(--dd-accent)]/50"
                            }`}
                        >
                            {f.label}
                        </button>
                    );
                })}
            </div>
            <span className="text-[var(--dd-text-muted)]">·</span>
            <div className="flex flex-wrap items-center gap-1">
                <span className="text-[10px] uppercase tracking-wide text-[var(--dd-text-muted)]">Sort</span>
                {SORTS.map((s) => {
                    const active = sortKey === s.id;
                    return (
                        <button
                            key={s.id}
                            type="button"
                            title="Click to sort · click again or double-click to flip direction"
                            onClick={() => handleSortClick(s.id)}
                            onDoubleClick={() => handleSortDblClick(s.id)}
                            className={`rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors ${
                                active
                                    ? "border-[var(--dd-accent)] bg-[var(--dd-accent)]/15 text-[var(--dd-accent)]"
                                    : "border-[var(--dd-border)] text-[var(--dd-text-secondary)] hover:border-[var(--dd-accent)]/50"
                            }`}
                        >
                            {s.label}
                            {active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
