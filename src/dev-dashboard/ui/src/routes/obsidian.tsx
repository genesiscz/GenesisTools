import {
    expandedDirsForFolderToggle,
    expandedDirsForNote,
    parseOpenDirs,
    serializeOpenDirs,
} from "@app/utils/obsidian/expanded-dirs";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { IconButton } from "@ui/components/icon-button";
import { cn } from "@ui/lib/utils";
import { ChevronDown, ChevronUp, FolderTree, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ObsidianReader } from "@/components/ObsidianReader";
import { ObsidianTree } from "@/components/ObsidianTree";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { obsidianApi } from "@/lib/api";

function noteDisplayName(path: string): string {
    return path.split("/").pop() ?? path;
}

export function ObsidianRoute() {
    const { data, error } = useQuery({ queryKey: ["obsidian", "tree"], queryFn: obsidianApi.tree });
    const navigate = useNavigate({ from: "/obsidian" });
    const { note, open } = useSearch({ from: "/obsidian" });
    const isMobile = useMediaQuery("(max-width: 768px)");
    const [browserOpen, setBrowserOpen] = useState(false);

    const openDirs = useMemo(() => parseOpenDirs(open), [open]);

    const displayOpenDirs = useMemo(() => {
        if (!note) {
            return openDirs;
        }

        return expandedDirsForNote(note, openDirs);
    }, [note, openDirs]);

    const pushSearch = useCallback(
        (next: { note?: string; open?: Set<string> }) => {
            const openSerialized = serializeOpenDirs(next.open ?? openDirs);
            const search: { note?: string; open?: string } = {};

            const notePath = next.note !== undefined ? next.note : note;

            if (notePath) {
                search.note = notePath;
            }

            if (openSerialized) {
                search.open = openSerialized;
            }

            navigate({ search, replace: true });
        },
        [navigate, note, openDirs]
    );

    const onFolderToggle = useCallback(
        (dir: string, expanded: boolean) => {
            const nextOpen = expandedDirsForFolderToggle(dir, expanded, openDirs);
            pushSearch({ open: nextOpen });
        },
        [openDirs, pushSearch]
    );

    const onSelectNote = useCallback(
        (path: string) => {
            const nextOpen = expandedDirsForNote(path, openDirs);
            pushSearch({ note: path, open: nextOpen });

            if (isMobile) {
                setBrowserOpen(false);
            }
        },
        [isMobile, openDirs, pushSearch]
    );

    useEffect(() => {
        if (!browserOpen) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setBrowserOpen(false);
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [browserOpen]);

    const treePanel = data ? (
        <ObsidianTree
            fillHeight
            entries={data.entries}
            selected={note ?? null}
            expandedDirs={displayOpenDirs}
            onFolderToggle={onFolderToggle}
            onSelect={onSelectNote}
        />
    ) : (
        <p className="font-mono text-[11px] text-[var(--dd-text-muted)]">
            {error instanceof Error ? error.message : "Loading vault..."}
        </p>
    );

    const reader = note ? (
        <ObsidianReader path={note} />
    ) : (
        <div className="dd-panel flex h-full items-center justify-center px-4 text-center text-[var(--dd-text-muted)]">
            {isMobile ? "Open the vault browser above to pick a note." : "Pick a note on the left."}
        </div>
    );

    const noteLabel = note ? noteDisplayName(note) : null;

    return (
        <div
            className={cn(
                "relative min-h-0",
                isMobile
                    ? "flex h-[calc(100dvh-5rem)] flex-col gap-2"
                    : "grid h-[calc(100dvh-5rem)] grid-cols-[minmax(220px,280px)_1fr] gap-2"
            )}
        >
            {isMobile ? (
                <>
                    <header className="dd-panel flex shrink-0 items-center gap-2 px-2 py-2">
                        <button
                            type="button"
                            className="dd-obsidian-browse-btn"
                            aria-expanded={browserOpen}
                            aria-controls="obsidian-vault-browser"
                            onClick={() => setBrowserOpen((open) => !open)}
                        >
                            <FolderTree size={14} aria-hidden />
                            <span>Vault</span>
                            {browserOpen ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
                        </button>
                        <span
                            className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--dd-text-muted)]"
                            title={note ?? undefined}
                        >
                            {noteLabel ?? "No note selected"}
                        </span>
                    </header>

                    {browserOpen ? (
                        <div
                            className="dd-obsidian-browser-backdrop"
                            onClick={() => setBrowserOpen(false)}
                            role="presentation"
                        >
                            <section
                                id="obsidian-vault-browser"
                                className="dd-obsidian-browser"
                                aria-label="Vault browser"
                                onClick={(event) => event.stopPropagation()}
                            >
                                <div className="dd-obsidian-browser-chrome">
                                    <span>Browse vault</span>
                                    <IconButton
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="size-7"
                                        tooltip="Close"
                                        aria-label="Close vault browser"
                                        onClick={() => setBrowserOpen(false)}
                                    >
                                        <X size={14} />
                                    </IconButton>
                                </div>
                                <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">{treePanel}</div>
                            </section>
                        </div>
                    ) : null}

                    <main className="min-h-0 flex-1 overflow-hidden">{reader}</main>
                </>
            ) : (
                <>
                    <aside className="dd-panel flex h-full min-h-0 flex-col overflow-hidden p-2">{treePanel}</aside>
                    <main className="min-h-0 overflow-hidden">{reader}</main>
                </>
            )}
        </div>
    );
}
