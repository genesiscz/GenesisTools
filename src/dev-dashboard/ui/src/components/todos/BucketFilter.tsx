import type { ReminderListInfo } from "@genesiscz/darwinkit";
import { useEffect, useRef, useState } from "react";

interface BucketFilterProps {
    lists: ReminderListInfo[];
    selected: string[];
    onChange: (names: string[]) => void;
    defaultList: string;
}

export function BucketFilter({ lists, selected, onChange, defaultList }: BucketFilterProps) {
    const [open, setOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);

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

    const titles = lists.map((list) => list.title);
    const effectiveSelected = selected.length > 0 ? selected : [defaultList];
    const allSelected = titles.length > 0 && titles.every((title) => effectiveSelected.includes(title));
    const summary =
        effectiveSelected.length === 0
            ? "No buckets"
            : allSelected
              ? "All buckets"
              : effectiveSelected.length === 1
                ? effectiveSelected[0]
                : `${effectiveSelected.length} buckets`;

    const toggle = (name: string) => {
        if (effectiveSelected.includes(name)) {
            const next = effectiveSelected.filter((item) => item !== name);

            if (next.length === 0) {
                onChange([defaultList]);
                return;
            }

            onChange(next);
            return;
        }

        onChange([...effectiveSelected, name]);
    };

    const selectAll = () => {
        if (titles.length === 0) {
            onChange([defaultList]);
            return;
        }

        onChange(titles);
    };

    const selectDefault = () => {
        onChange([defaultList]);
    };

    return (
        <div ref={panelRef} className="relative">
            <button
                type="button"
                aria-expanded={open}
                aria-haspopup="listbox"
                onClick={() => setOpen((value) => !value)}
                className="rounded-md border border-[var(--dd-border)] bg-[var(--dd-bg-panel)] px-3 py-1.5 text-sm text-[var(--dd-text-primary)] transition-colors hover:border-[var(--dd-accent-from)]"
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
                        {(titles.length > 0 ? titles : [defaultList]).map((name) => {
                            const checked = effectiveSelected.includes(name);

                            return (
                                <li key={name}>
                                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--dd-border)]/30">
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => toggle(name)}
                                            className="accent-[var(--dd-accent-from)]"
                                        />
                                        <span className="truncate text-[var(--dd-text-primary)]">{name}</span>
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
