import type { VaultEntry } from "@app/dev-dashboard/lib/obsidian/types";
import { Input } from "@ui/components/input";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { useMemo, useState } from "react";

interface Props {
    entries: VaultEntry[];
    onSelect: (relativePath: string) => void;
    selected: string | null;
}

function filterEntries(entries: VaultEntry[], query: string): VaultEntry[] {
    if (!query) {
        return entries;
    }

    return entries.flatMap((entry) => {
        if (entry.isDirectory) {
            const children = filterEntries(entry.children ?? [], query);

            if (children.length > 0 || entry.name.toLowerCase().includes(query)) {
                return [{ ...entry, children }];
            }

            return [];
        }

        return entry.name.toLowerCase().includes(query) ? [entry] : [];
    });
}

function Node({
    entry,
    onSelect,
    selected,
    forceOpen,
}: {
    entry: VaultEntry;
    onSelect: Props["onSelect"];
    selected: string | null;
    forceOpen: boolean;
}) {
    const [open, setOpen] = useState(false);

    if (entry.isDirectory) {
        const expanded = forceOpen || open;

        return (
            <li>
                <button
                    type="button"
                    className="flex w-full items-center gap-1 px-1 text-left font-mono text-[11px] text-[var(--dd-text-secondary)] hover:text-[var(--dd-text-primary)]"
                    onClick={() => setOpen((value) => !value)}
                >
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <Folder size={12} />
                    <span className="truncate">{entry.name}</span>
                </button>
                {expanded ? (
                    <ul className="ml-3 mt-0.5 border-l border-[var(--dd-border)] pl-2">
                        {(entry.children ?? []).map((child) => (
                            <Node
                                key={child.relativePath}
                                entry={child}
                                onSelect={onSelect}
                                selected={selected}
                                forceOpen={forceOpen}
                            />
                        ))}
                    </ul>
                ) : null}
            </li>
        );
    }

    const isActive = selected === entry.relativePath;

    return (
        <li>
            <button
                type="button"
                className="flex w-full items-center gap-1 rounded px-1 text-left font-mono text-[11px]"
                style={
                    isActive
                        ? { background: "var(--dd-accent-gradient)", color: "#0c0e10" }
                        : { color: "var(--dd-text-secondary)" }
                }
                onClick={() => onSelect(entry.relativePath)}
            >
                <FileText size={12} />
                <span className="truncate">{entry.name.replace(/\.md$/, "")}</span>
            </button>
        </li>
    );
}

export function ObsidianTree({ entries, onSelect, selected }: Props) {
    const [query, setQuery] = useState("");
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = useMemo(() => filterEntries(entries, normalizedQuery), [entries, normalizedQuery]);

    return (
        <div className="space-y-2">
            <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search notes"
                className="h-8 border-[var(--dd-border)] bg-black/20 text-xs"
            />
            <ul className="space-y-0.5">
                {filtered.map((entry) => (
                    <Node
                        key={entry.relativePath}
                        entry={entry}
                        onSelect={onSelect}
                        selected={selected}
                        forceOpen={normalizedQuery.length > 0}
                    />
                ))}
            </ul>
        </div>
    );
}
