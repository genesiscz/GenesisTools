import { type KeyboardEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * A list the user reorders by dragging a grip (or the whole row) or with the
 * keyboard: Space picks an item up, Up and Down move it, Space or Enter drops
 * it, Escape puts it back. Plain pointer events, no drag library, so a page
 * that does not render a SortableList carries none of this.
 */

export interface SortableItem {
    id: string;
    content: ReactNode;
    /** A disabled item cannot be picked up and is never displaced. */
    disabled?: boolean;
    /** Name used in announcements and the grip label. Default: the content when it is text, else the id. */
    label?: string;
}

export interface SortableMove {
    id: string;
    from: number;
    to: number;
}

export interface SortableListProps {
    items: SortableItem[];
    onReorder: (ids: string[], moved: SortableMove) => void;
    /** "grip": only the handle drags. "row": the whole row drags. Default "grip". */
    handle?: "grip" | "row";
    orientation?: "vertical" | "horizontal";
    /** Print 1, 2, 3 before each item. */
    ordered?: boolean;
    /** Accessible name of the list. */
    label: string;
    /** Add Move up and Move down buttons for people who cannot drag at all. */
    buttons?: boolean;
}

/** Pure move: a new array with the item at `from` placed at `to`. The input is untouched. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
    const next = items.slice();
    const [item] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, item);

    return next;
}

/** True when moving `from` to `to` would shift a disabled item (or move a disabled one). */
export function sortableMoveBlocked(items: Array<{ disabled?: boolean }>, from: number, to: number): boolean {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);

    for (let i = lo; i <= hi; i += 1) {
        if (items[i]?.disabled) {
            return true;
        }
    }

    return false;
}

function nameOf(item: SortableItem): string {
    return item.label ?? (typeof item.content === "string" ? item.content : item.id);
}

interface PointerDrag {
    id: string;
    from: number;
    to: number;
    /** Midpoints of the OTHER items, in their original order, measured at pointer down. */
    mids: number[];
}

/** Reorderable list. See the module comment for the keyboard model. */
export function SortableList({
    items,
    onReorder,
    handle = "grip",
    orientation = "vertical",
    ordered = false,
    label,
    buttons = false,
}: SortableListProps) {
    const vertical = orientation === "vertical";
    // A keyboard pick: the item and where it currently sits in the working order.
    const [picked, setPicked] = useState<{ id: string; from: number; to: number } | null>(null);
    const [drag, setDrag] = useState<PointerDrag | null>(null);
    const dragRef = useRef<PointerDrag | null>(null);
    const [announce, setAnnounce] = useState("");
    const itemRefs = useRef(new Map<string, HTMLElement>());
    const gripRefs = useRef(new Map<string, HTMLElement>());
    const lastRects = useRef(new Map<string, DOMRect>());

    const moving = picked ?? drag;
    const shown = moving ? moveItem(items, moving.from, moving.to) : items;
    const total = items.length;

    // The others slide into place (a FLIP over 120 ms) when the working order changes.
    useLayoutEffect(() => {
        const reduce =
            typeof window.matchMedia !== "function" ||
            !window.matchMedia("(prefers-reduced-motion: no-preference)").matches;

        for (const [id, el] of itemRefs.current) {
            const before = lastRects.current.get(id);
            const after = el.getBoundingClientRect();
            lastRects.current.set(id, after);

            if (reduce || !before || id === moving?.id) {
                continue;
            }

            const delta = vertical ? before.top - after.top : before.left - after.left;

            if (delta !== 0 && typeof el.animate === "function") {
                const axis = vertical ? "translateY" : "translateX";
                el.animate([{ transform: `${axis}(${delta}px)` }, { transform: `${axis}(0)` }], {
                    duration: 120,
                    easing: "ease-out",
                });
            }
        }
    });

    const commit = (move: { id: string; from: number; to: number }): void => {
        if (move.from === move.to) {
            return;
        }

        const next = moveItem(items, move.from, move.to);
        onReorder(
            next.map((item) => item.id),
            { id: move.id, from: move.from, to: move.to }
        );
        const item = items[move.from];
        setAnnounce(`Moved ${nameOf(item)} to position ${move.to + 1} of ${total}`);
    };

    const tryMove = (from: number, to: number): boolean =>
        to >= 0 && to < total && !sortableMoveBlocked(items, from, to);

    const onGripKey = (event: KeyboardEvent<HTMLElement>, item: SortableItem, index: number): void => {
        const back = vertical ? "ArrowUp" : "ArrowLeft";
        const forward = vertical ? "ArrowDown" : "ArrowRight";

        if (!picked) {
            if ((event.key === " " || event.key === "Enter") && !item.disabled) {
                event.preventDefault();
                setPicked({ id: item.id, from: index, to: index });
                setAnnounce(
                    `Picked up ${nameOf(item)}, position ${index + 1} of ${total}. Use the arrow keys to move.`
                );
            }

            return;
        }

        if (event.key === back || event.key === forward) {
            event.preventDefault();
            const to = picked.to + (event.key === forward ? 1 : -1);

            if (tryMove(picked.from, to)) {
                setPicked({ ...picked, to });
                setAnnounce(`${nameOf(items[picked.from])}, position ${to + 1} of ${total}`);
            }

            return;
        }

        if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            const done = picked;
            setPicked(null);

            if (done.from === done.to) {
                setAnnounce(`Dropped ${nameOf(items[done.from])}, position unchanged`);
            } else {
                commit(done);
            }

            return;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            setPicked(null);
            setAnnounce(`Cancelled. ${nameOf(items[picked.from])} stays at position ${picked.from + 1} of ${total}`);
        }
    };

    // Keep focus on the picked item's grip while it moves through the list.
    useLayoutEffect(() => {
        if (picked) {
            gripRefs.current.get(picked.id)?.focus();
        }
    }, [picked]);

    const onPointerDown = (event: PointerEvent<HTMLElement>, item: SortableItem, index: number): void => {
        if (event.button !== 0 || item.disabled || picked) {
            return;
        }

        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const mids: number[] = [];

        for (const other of items) {
            if (other.id === item.id) {
                continue;
            }

            const rect = itemRefs.current.get(other.id)?.getBoundingClientRect();
            mids.push(rect ? (vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2) : 0);
        }

        dragRef.current = { id: item.id, from: index, to: index, mids };
        setDrag(dragRef.current);
    };

    const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
        const current = dragRef.current;

        if (!current) {
            return;
        }

        const at = vertical ? event.clientY : event.clientX;
        const to = current.mids.filter((mid) => mid < at).length;

        if (to !== current.to && tryMove(current.from, to)) {
            dragRef.current = { ...current, to };
            setDrag(dragRef.current);
        }
    };

    const onPointerEnd = (apply: boolean): void => {
        const current = dragRef.current;
        dragRef.current = null;
        setDrag(null);

        if (current && apply) {
            commit(current);
        }
    };

    // Escape during a pointer drag puts the item back; the release then commits nothing.
    useLayoutEffect(() => {
        if (!drag) {
            return;
        }

        const onKey = (event: globalThis.KeyboardEvent): void => {
            if (event.key === "Escape") {
                dragRef.current = null;
                setDrag(null);
            }
        };
        document.addEventListener("keydown", onKey);

        return () => document.removeEventListener("keydown", onKey);
    }, [drag]);

    const gripClass =
        "flex h-8 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded text-dim hover:bg-canvas hover:text-ink active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info disabled:cursor-not-allowed disabled:opacity-40";
    const smallButton =
        "rounded px-1.5 py-0.5 text-xs text-dim hover:bg-canvas hover:text-ink disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info";

    return (
        <div>
            <ol aria-label={label} className={`flex gap-1.5 ${vertical ? "flex-col" : "flex-row flex-wrap"} list-none`}>
                {shown.map((item) => {
                    const index = items.indexOf(item);
                    const position = shown.indexOf(item);
                    const lifted = moving?.id === item.id;
                    const dragHandlers = {
                        onPointerDown: (event: PointerEvent<HTMLElement>) => onPointerDown(event, item, index),
                        onPointerMove,
                        onPointerUp: () => onPointerEnd(true),
                        onPointerCancel: () => onPointerEnd(false),
                    };

                    return (
                        <li
                            key={item.id}
                            ref={(el) => {
                                if (el) {
                                    itemRefs.current.set(item.id, el);
                                } else {
                                    itemRefs.current.delete(item.id);
                                }
                            }}
                            data-sortable-item={item.id}
                            className={`relative flex items-center gap-2 rounded-card border bg-panel px-3 py-2 ${
                                lifted ? "z-10 scale-[1.01] border-accent shadow-lg" : "border-line"
                            } ${item.disabled ? "opacity-70" : ""} ${handle === "row" && !item.disabled ? "cursor-grab touch-none" : ""}`}
                            {...(handle === "row" ? dragHandlers : {})}
                        >
                            {lifted ? (
                                <span
                                    aria-hidden="true"
                                    data-sortable-slot=""
                                    className={`absolute rounded bg-accent ${vertical ? "-top-[5px] right-0 left-0 h-0.5" : "top-0 bottom-0 -left-[5px] w-0.5"}`}
                                />
                            ) : null}
                            <button
                                type="button"
                                ref={(el) => {
                                    if (el) {
                                        gripRefs.current.set(item.id, el);
                                    } else {
                                        gripRefs.current.delete(item.id);
                                    }
                                }}
                                disabled={item.disabled}
                                aria-label={`Reorder ${nameOf(item)}, position ${position + 1} of ${total}`}
                                aria-pressed={picked?.id === item.id}
                                onKeyDown={(event) => onGripKey(event, item, index)}
                                onBlur={() => {
                                    if (picked?.id === item.id) {
                                        setPicked(null);
                                    }
                                }}
                                className={gripClass}
                                {...(handle === "grip" ? dragHandlers : {})}
                            >
                                <span aria-hidden="true">⋮⋮</span>
                            </button>
                            {ordered ? (
                                <span className="w-5 shrink-0 text-right font-mono text-xs text-dim tabular-nums">
                                    {position + 1}
                                </span>
                            ) : null}
                            <div className="min-w-0 flex-1">{item.content}</div>
                            {buttons ? (
                                <span className="inline-flex shrink-0 gap-0.5">
                                    <button
                                        type="button"
                                        className={smallButton}
                                        disabled={!tryMove(index, index - 1)}
                                        onClick={() => commit({ id: item.id, from: index, to: index - 1 })}
                                        aria-label={`Move ${nameOf(item)} up`}
                                    >
                                        {vertical ? "Move up" : "Move left"}
                                    </button>
                                    <button
                                        type="button"
                                        className={smallButton}
                                        disabled={!tryMove(index, index + 1)}
                                        onClick={() => commit({ id: item.id, from: index, to: index + 1 })}
                                        aria-label={`Move ${nameOf(item)} down`}
                                    >
                                        {vertical ? "Move down" : "Move right"}
                                    </button>
                                </span>
                            ) : null}
                        </li>
                    );
                })}
            </ol>
            <div aria-live="polite" className="sr-only" data-sortable-live="">
                {announce}
            </div>
        </div>
    );
}
