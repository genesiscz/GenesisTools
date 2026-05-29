import type { ReminderListInfo } from "@genesiscz/darwinkit";
import { useEffect, useMemo, useRef, useState } from "react";

interface BucketFilterProps {
    lists: ReminderListInfo[];
    selectedIds: string[];
    onChange: (ids: string[]) => void;
    defaultList: string;
}

export function BucketFilter({ lists, selectedIds, onChange, defaultList }: BucketFilterProps) {
    const [open, setOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);

    const bucketLists = useMemo(() => {
        const seen = new Set<string>();

        return lists.filter((list) => {
            if (seen.has(list.identifier)) {
                return false;
            }

            seen.add(list.identifier);
            return true;
        });
    }, [lists]);

    const defaultListId = useMemo(
        () => bucketLists.find((list) => list.title === defaultList)?.identifier ?? bucketLists[0]?.identifier,
        [bucketLists, defaultList]
    );

    useEffect(() => {
        if (!open) {
            return;
        }

        const onPointerDown = (event: MouseEvent) => {
            if (!panelRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };

        document.addEventListener("mousedown", onPointerDown);
        return () => document.removeEventListener("mousedown", onPointerDown);
    }, [open]);

    const effectiveSelected = useMemo(() => {
        const valid = selectedIds.filter((id) => bucketLists.some((list) => list.identifier === id));

        if (valid.length > 0) {
            return [...new Set(valid)];
        }

        if (defaultListId) {
            return [defaultListId];
        }

        return [];
    }, [selectedIds, bucketLists, defaultListId]);

    const allSelected =
        bucketLists.length > 0 && bucketLists.every((list) => effectiveSelected.includes(list.identifier));
    const summary =
        effectiveSelected.length === 0
            ? "No buckets"
            : allSelected
              ? "All buckets"
              : effectiveSelected.length === 1
                ? (bucketLists.find((list) => list.identifier === effectiveSelected[0])?.title ?? "1 bucket")
                : `${effectiveSelected.length} buckets`;

    const toggle = (listId: string) => {
        if (effectiveSelected.includes(listId)) {
            const next = effectiveSelected.filter((item) => item !== listId);

            if (next.length === 0) {
                if (defaultListId) {
                    onChange([defaultListId]);
                }

                return;
            }

            onChange(next);
            return;
        }

        onChange([...new Set([...effectiveSelected, listId])]);
    };

    const selectAll = () => {
        if (bucketLists.length === 0) {
            if (defaultListId) {
                onChange([defaultListId]);
            }

            return;
        }

        onChange(bucketLists.map((list) => list.identifier));
    };

    const selectDefault = () => {
        if (defaultListId) {
            onChange([defaultListId]);
        }
    };

    return (
        <div ref={panelRef} className="relative">
            <button
                type="button"
                aria-expanded={open}
                aria-haspopup="listbox"
                onClick={() => setOpen((value) => !value)}
                className="cursor-pointer rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 text-sm text-[var(--dd-text-primary)] transition-colors hover:border-[var(--dd-accent-from)] hover:bg-[var(--dd-border)]/20"
            >
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dd-text-muted)]">
                    Buckets{" "}
                </span>
                {summary}
            </button>

            {open ? (
                <div
                    role="listbox"
                    aria-label="Reminder buckets"
                    className="absolute right-0 z-20 mt-1 min-w-[14rem] rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] p-2 shadow-lg shadow-black/40"
                >
                    <div className="mb-2 flex gap-1 border-b border-[var(--dd-border)] pb-2">
                        <button type="button" className="dd-tab text-[11px]" onClick={selectAll}>
                            All
                        </button>
                        <button type="button" className="dd-tab text-[11px]" onClick={selectDefault}>
                            Default
                        </button>
                    </div>
                    <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                        {(bucketLists.length > 0
                            ? bucketLists
                            : defaultListId
                              ? [{ identifier: defaultListId, title: defaultList, color: "", source: "" }]
                              : []
                        ).map((list) => {
                            const checked = effectiveSelected.includes(list.identifier);

                            return (
                                <li key={list.identifier}>
                                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--dd-border)]/30">
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => toggle(list.identifier)}
                                            className="accent-[var(--dd-accent-from)]"
                                        />
                                        <span className="truncate text-[var(--dd-text-primary)]">{list.title}</span>
                                    </label>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}
