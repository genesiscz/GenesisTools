import type { VaultEntry } from "@app/dev-dashboard/lib/obsidian/types";
import { IconButton } from "@ui/components/icon-button";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib/utils";
import { ChevronDown, ChevronRight, FileText, Folder, Plus } from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";
import { ObsidianNewFolderDialog } from "./ObsidianNewFolderDialog";

export type ObsidianTreeSelection = "directory" | "file" | "both";

interface Props {
    entries: VaultEntry[];
    onSelect: (relativePath: string) => void;
    selected: string | null;
    /** `directory` = folders only. `file` = notes only. `both` = either (save dialog picks mode from click). */
    selection?: ObsidianTreeSelection;
    allowAddDir?: boolean;
    onTreeChange?: () => void;
    listClassName?: string;
    /** Fill parent height; list scrolls (use on /obsidian sidebar). */
    fillHeight?: boolean;
    /** Controlled expand state (URL-synced on /obsidian). Omit for local-only expand. */
    expandedDirs?: ReadonlySet<string>;
    onFolderToggle?: (dir: string, expanded: boolean) => void;
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

const rowButtonClass =
    "flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded px-1 text-left font-mono text-[11px] text-[var(--dd-text-secondary)] transition-colors hover:bg-[var(--dd-border)]/25 hover:text-[var(--dd-text-primary)]";

function activeRowStyle(isActive: boolean): CSSProperties | undefined {
    if (!isActive) {
        return undefined;
    }

    return { background: "var(--dd-accent-gradient)", color: "#0c0e10" };
}

function Node({
    entry,
    onSelect,
    selected,
    forceOpen,
    selection,
    expandedDirs,
    onFolderToggle,
}: {
    entry: VaultEntry;
    onSelect: Props["onSelect"];
    selected: string | null;
    forceOpen: boolean;
    selection: ObsidianTreeSelection;
    expandedDirs?: ReadonlySet<string>;
    onFolderToggle?: (dir: string, expanded: boolean) => void;
}) {
    const [openLocal, setOpenLocal] = useState(false);
    const isControlled = expandedDirs !== undefined;

    const setExpanded = (next: boolean): void => {
        if (isControlled && onFolderToggle) {
            onFolderToggle(entry.relativePath, next);
            return;
        }

        setOpenLocal(next);
    };

    const toggleExpanded = (): void => {
        const next = !(forceOpen || (isControlled ? expandedDirs.has(entry.relativePath) : openLocal));
        setExpanded(next);
    };

    if (entry.isDirectory) {
        const expanded = forceOpen || (isControlled ? expandedDirs.has(entry.relativePath) : openLocal);
        const folderSelectable = selection === "directory" || selection === "both";
        const isActive = folderSelectable && selected === entry.relativePath;

        return (
            <li>
                <div className="flex w-full items-center gap-0.5">
                    <button
                        type="button"
                        className="shrink-0 cursor-pointer px-0.5 text-[var(--dd-text-secondary)] transition-colors hover:text-[var(--dd-text-primary)]"
                        aria-label={expanded ? "Collapse folder" : "Expand folder"}
                        aria-expanded={expanded}
                        onClick={(event) => {
                            event.stopPropagation();
                            toggleExpanded();
                        }}
                    >
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <button
                        type="button"
                        className={rowButtonClass}
                        style={activeRowStyle(isActive)}
                        onClick={() => {
                            toggleExpanded();

                            if (folderSelectable) {
                                onSelect(entry.relativePath);
                            }
                        }}
                    >
                        <Folder size={12} className="shrink-0" />
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
                                selection={selection}
                                expandedDirs={expandedDirs}
                                onFolderToggle={onFolderToggle}
                            />
                        ))}
                    </ul>
                ) : null}
            </li>
        );
    }

    const fileSelectable = selection === "file" || selection === "both";
    const isActive = fileSelectable && selected === entry.relativePath;
    const browseOnly = selection === "directory";

    return (
        <li>
            <div className="flex w-full items-center gap-0.5">
                <span className="w-[18px] shrink-0" aria-hidden />
                <button
                    type="button"
                    className={cn(rowButtonClass, browseOnly && "cursor-default opacity-55 hover:opacity-70")}
                    style={activeRowStyle(isActive)}
                    disabled={browseOnly}
                    onClick={() => onSelect(entry.relativePath)}
                >
                    <FileText size={12} className="shrink-0 opacity-80" />
                    <span className="truncate">{entry.name}</span>
                </button>
            </div>
        </li>
    );
}

export function splitObsidianNotePath(relativePath: string): { dir: string; baseName: string } {
    const normalized = relativePath.replace(/\\/g, "/");
    const slash = normalized.lastIndexOf("/");
    const file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const dir = slash >= 0 ? normalized.slice(0, slash) : "";

    return {
        dir,
        baseName: file.replace(/\.md$/i, ""),
    };
}

export function ObsidianTree({
    entries,
    onSelect,
    selected,
    selection = "file",
    allowAddDir,
    onTreeChange,
    listClassName,
    fillHeight = false,
    expandedDirs,
    onFolderToggle,
}: Props) {
    const [query, setQuery] = useState("");
    const [addFolderOpen, setAddFolderOpen] = useState(false);
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = useMemo(() => filterEntries(entries, normalizedQuery), [entries, normalizedQuery]);

    const parentDir =
        selection === "directory" && selected
            ? selected
            : selection === "file" && selected
              ? splitObsidianNotePath(selected).dir
              : "";

    const onFolderCreated = (relativeDir: string): void => {
        if (selection === "directory") {
            onSelect(relativeDir);
        }

        onTreeChange?.();
    };

    const placeholder =
        selection === "directory"
            ? "Search folders"
            : selection === "both"
              ? "Search folders and notes"
              : "Search notes";

    return (
        <div className={cn("flex min-h-0 flex-col gap-2", fillHeight && "h-full")}>
            <div className="flex shrink-0 gap-2">
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={placeholder}
                    className="h-8 flex-1 border-[var(--dd-border)] bg-black/20 text-xs"
                />
                {allowAddDir ? (
                    <IconButton
                        type="button"
                        variant="outline"
                        className="h-8 w-8 shrink-0"
                        tooltip="Add folder"
                        onClick={() => setAddFolderOpen(true)}
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </IconButton>
                ) : null}
            </div>
            <ObsidianNewFolderDialog
                open={addFolderOpen}
                onOpenChange={setAddFolderOpen}
                parentDir={parentDir}
                onCreated={onFolderCreated}
            />
            <ul
                className={cn("min-h-0 space-y-0.5 overflow-y-auto", fillHeight ? "flex-1" : "max-h-48", listClassName)}
            >
                {filtered.map((entry) => (
                    <Node
                        key={entry.relativePath}
                        entry={entry}
                        onSelect={onSelect}
                        selected={selected}
                        forceOpen={normalizedQuery.length > 0}
                        selection={selection}
                        expandedDirs={expandedDirs}
                        onFolderToggle={onFolderToggle}
                    />
                ))}
            </ul>
        </div>
    );
}
