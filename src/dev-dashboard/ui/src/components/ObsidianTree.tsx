import type { VaultEntry } from "@app/dev-dashboard/lib/obsidian/types";
import { SafeJSON } from "@app/utils/json";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { ChevronDown, ChevronRight, FileText, Folder, Plus } from "lucide-react";
import { useMemo, useState } from "react";

interface Props {
    entries: VaultEntry[];
    onSelect: (relativePath: string) => void;
    selected: string | null;
    selectDirectories?: boolean;
    allowAddDir?: boolean;
    onTreeChange?: () => void;
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
    selectDirectories,
}: {
    entry: VaultEntry;
    onSelect: Props["onSelect"];
    selected: string | null;
    forceOpen: boolean;
    selectDirectories?: boolean;
}) {
    const [open, setOpen] = useState(false);

    if (entry.isDirectory) {
        const expanded = forceOpen || open;
        const isActive = selectDirectories && selected === entry.relativePath;

        return (
            <li>
                <div className="flex w-full items-center gap-0.5">
                    <button
                        type="button"
                        className="shrink-0 px-0.5 text-[var(--dd-text-secondary)]"
                        aria-label={expanded ? "Collapse folder" : "Expand folder"}
                        onClick={() => setOpen((value) => !value)}
                    >
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-left font-mono text-[11px]"
                        style={
                            isActive
                                ? { background: "var(--dd-accent-gradient)", color: "#0c0e10" }
                                : { color: "var(--dd-text-secondary)" }
                        }
                        onClick={() => {
                            if (selectDirectories) {
                                onSelect(entry.relativePath);
                            } else {
                                setOpen((value) => !value);
                            }
                        }}
                    >
                        <Folder size={12} />
                        <span className="truncate">{entry.name}</span>
                    </button>
                </div>
                {expanded ? (
                    <ul className="mt-0.5 ml-3 border-l border-[var(--dd-border)] pl-2">
                        {(entry.children ?? []).map((child) => (
                            <Node
                                key={child.relativePath}
                                entry={child}
                                onSelect={onSelect}
                                selected={selected}
                                forceOpen={forceOpen}
                                selectDirectories={selectDirectories}
                            />
                        ))}
                    </ul>
                ) : null}
            </li>
        );
    }

    if (selectDirectories) {
        return null;
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

export function ObsidianTree({
    entries,
    onSelect,
    selected,
    selectDirectories,
    allowAddDir,
    onTreeChange,
}: Props) {
    const [query, setQuery] = useState("");
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = useMemo(() => filterEntries(entries, normalizedQuery), [entries, normalizedQuery]);

    const addDir = async (): Promise<void> => {
        const parent = selected && selectDirectories ? selected : "";
        const name = window.prompt("New folder name");

        if (!name?.trim()) {
            return;
        }

        const relativeDir = parent ? `${parent}/${name.trim()}` : name.trim();

        await fetch("/api/obsidian/mkdir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ relativeDir }),
        });
        onSelect(relativeDir);
        onTreeChange?.();
    };

    return (
        <div className="space-y-2">
            <div className="flex gap-2">
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search notes"
                    className="h-8 flex-1 border-[var(--dd-border)] bg-black/20 text-xs"
                />
                {allowAddDir ? (
                    <Button type="button" size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={() => void addDir()} title="Add folder">
                        <Plus className="h-3.5 w-3.5" />
                    </Button>
                ) : null}
            </div>
            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                {filtered.map((entry) => (
                    <Node
                        key={entry.relativePath}
                        entry={entry}
                        onSelect={onSelect}
                        selected={selected}
                        forceOpen={normalizedQuery.length > 0}
                        selectDirectories={selectDirectories}
                    />
                ))}
            </ul>
        </div>
    );
}
