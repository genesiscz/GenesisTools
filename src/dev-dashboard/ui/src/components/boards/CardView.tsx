import type { CardDto } from "@app/dev-dashboard/contract/dto";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import type {
    CSSProperties,
    MouseEvent as ReactMouseEvent,
    ReactNode,
    PointerEvent as ReactPointerEvent,
    RefObject,
} from "react";
import { useEffect, useRef, useState } from "react";
import {
    CalloutCard,
    ChecklistCard,
    ClusterFrame,
    CompareRefCard,
    type EditCellFn,
    ShapeCard,
    StepCard,
    TextCard,
    VizCard,
    WireframeCard,
} from "./AiCards";
import type { Tool } from "./Toolbar";

export type ResizeCorner = "nw" | "ne" | "sw" | "se" | "n" | "e" | "s" | "w";

const RESIZE_CORNERS: ResizeCorner[] = ["nw", "ne", "sw", "se", "n", "e", "s", "w"];

/** Which payload field a double-click edit writes, per card kind (vitrinka commitNoteEdit). */
export function editableField(kind: string): string | null {
    if (kind === "text" || kind === "callout") {
        return "md";
    }

    if (kind === "note") {
        return "text";
    }

    if (kind === "section" || kind === "cluster") {
        return "title";
    }

    if (kind === "shape") {
        return "label";
    }

    return null;
}

interface CardViewProps {
    card: CardDto;
    selected: boolean;
    scale: number;
    tool: Tool;
    hasPendingAttempt: boolean;
    editing: boolean;
    onSelect: (id: number) => void;
    onDragBy: (id: number, dxWorld: number, dyWorld: number) => void;
    onDragEnd: (id: number) => void;
    onResizeStart: (card: CardDto, corner: ResizeCorner, e: ReactPointerEvent) => void;
    onEditStart: (id: number) => void;
    onEditCommit: (card: CardDto, text: string) => void;
    onContentHeight: (card: CardDto, height: number) => void;
    onEditCell?: EditCellFn;
    /** True while a space-drag pan is arbitrating — the card yields so the canvas owns the gesture. */
    panningRef: RefObject<boolean>;
}

interface DragState {
    pointerId: number;
    lastClientX: number;
    lastClientY: number;
}

function stringField(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    return typeof value === "string" ? value : "";
}

/** Borderless textarea that IS the card body while editing; commits on blur, Esc blurs.
 *  Also commits on unmount — a canvas click can tear the editor down before the native blur
 *  fires, which would silently drop the edit. A done-flag prevents double commits. */
function InlineEditor({
    initial,
    mono,
    onCommit,
}: {
    initial: string;
    mono?: boolean;
    onCommit: (text: string) => void;
}) {
    const [draft, setDraft] = useState(initial);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const done = useRef(false);
    const commitRef = useRef(onCommit);
    commitRef.current = onCommit;

    const finish = () => {
        if (done.current) {
            return;
        }

        done.current = true;
        commitRef.current(draftRef.current);
    };

    const finishRef = useRef(finish);
    finishRef.current = finish;

    useEffect(() => {
        return () => finishRef.current();
    }, []);

    return (
        <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={finish}
            onKeyDown={(e) => {
                if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
                    e.currentTarget.blur();
                }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className={`h-full w-full resize-none bg-transparent text-[13.5px] leading-[1.55] text-[var(--dd-text-primary)] outline-none ${mono ? "font-mono" : ""}`}
        />
    );
}

/** Single-line section-title rename input. Same commit-on-unmount guard as InlineEditor: a canvas
 *  click can tear the input down before the native blur fires, which would silently drop the rename.
 *  A done-flag prevents double commits (unmount + blur). */
function SectionTitleInput({ initial, onCommit }: { initial: string; onCommit: (text: string) => void }) {
    const [draft, setDraft] = useState(initial);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const done = useRef(false);
    const commitRef = useRef(onCommit);
    commitRef.current = onCommit;

    const finish = () => {
        if (done.current) {
            return;
        }

        done.current = true;
        commitRef.current(draftRef.current);
    };

    const finishRef = useRef(finish);
    finishRef.current = finish;

    useEffect(() => {
        return () => finishRef.current();
    }, []);

    return (
        <input
            autoFocus
            value={draft}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={finish}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                    e.currentTarget.blur();
                }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute -top-6 left-0 w-48 rounded bg-[var(--dd-bg-panel)] px-1 font-mono text-xs font-semibold text-[var(--dd-text-primary)] outline-none"
        />
    );
}

export function CardView({
    card,
    selected,
    scale,
    tool,
    hasPendingAttempt,
    editing,
    onSelect,
    onDragBy,
    onDragEnd,
    onResizeStart,
    onEditStart,
    onEditCommit,
    onContentHeight,
    onEditCell,
    panningRef,
}: CardViewProps) {
    const dragRef = useRef<DragState | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);

    const editField = editableField(card.kind);
    const editValue = editField ? stringField(card.payload, editField) : "";

    // Grow-only measured-height write-back (vitrinka board-1.mjs:1341-1367): when rendered
    // markdown is taller than the box, ask the canvas to grow the card. userSized cards and
    // active editors are exempt; the handler upstream debounces the PATCH.
    const measure = useRef<() => void>(() => undefined);
    measure.current = () => {
        const el = bodyRef.current;

        if (!el || editing || card.payload.userSized === true) {
            return;
        }

        const clipped = el.scrollHeight - el.clientHeight;

        if (clipped > 2) {
            onContentHeight(card, card.h + clipped);
        }
    };

    useEffect(() => {
        measure.current();
    });

    useEffect(() => {
        const inner = bodyRef.current;

        if (!inner || typeof ResizeObserver === "undefined") {
            return;
        }

        const ro = new ResizeObserver(() => measure.current());
        ro.observe(inner);
        return () => ro.disconnect();
    }, []);

    const beginDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        // A space-drag pan owns the gesture: don't also start a card drag. The event bubbles to
        // the canvas (we don't capture the pointer), which begins the pan since space is held.
        if (panningRef.current || editing) {
            return;
        }

        onSelect(card.id);
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { pointerId: e.pointerId, lastClientX: e.clientX, lastClientY: e.clientY };
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;

        if (!drag || drag.pointerId !== e.pointerId) {
            return;
        }

        const dx = (e.clientX - drag.lastClientX) / scale;
        const dy = (e.clientY - drag.lastClientY) / scale;
        drag.lastClientX = e.clientX;
        drag.lastClientY = e.clientY;
        onDragBy(card.id, dx, dy);
    };

    const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === e.pointerId) {
            dragRef.current = null;
            onDragEnd(card.id);
        }
    };

    const dragHandlers = {
        onPointerDown: beginDrag,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
    };

    const editHandlers = editField
        ? {
              onDoubleClick: (e: ReactMouseEvent) => {
                  e.stopPropagation();
                  onEditStart(card.id);
              },
          }
        : {};

    const style: CSSProperties = {
        position: "absolute",
        left: card.x,
        top: card.y,
        width: card.w,
        height: card.h,
        zIndex: card.kind === "section" ? Math.min(card.z, -1) : card.z,
    };
    const ring = selected ? "ring-2 ring-[var(--dd-accent-from)]" : "ring-1 ring-[var(--dd-border)]";

    const handles =
        selected && tool === "move"
            ? RESIZE_CORNERS.map((corner) => (
                  <span
                      key={corner}
                      className={`dd-card-handle dd-card-handle-${corner}`}
                      onPointerDown={(e) => {
                          e.stopPropagation();
                          onResizeStart(card, corner, e);
                      }}
                  />
              ))
            : null;

    const wrap = (children: ReactNode, extra: { className?: string; bodyStyle?: CSSProperties } = {}) => (
        <div
            style={{ ...style, ...extra.bodyStyle }}
            data-card-id={card.id}
            data-card-kind={card.kind}
            className={extra.className}
            {...dragHandlers}
            {...editHandlers}
        >
            {children}
            {handles}
        </div>
    );

    if (card.kind === "section") {
        const title = stringField(card.payload, "title");

        return (
            <div
                style={style}
                data-card-id={card.id}
                data-card-kind="section"
                data-section-id={card.id}
                className={`rounded-lg border ${selected ? "border-[var(--dd-accent-from)]" : "border-[var(--dd-border)]"}`}
                {...dragHandlers}
                {...editHandlers}
            >
                {editing ? (
                    <SectionTitleInput initial={title} onCommit={(text) => onEditCommit(card, text)} />
                ) : (
                    <span className="absolute -top-6 left-0 cursor-move font-mono text-xs font-semibold text-[var(--dd-text-secondary)]">
                        {title}
                    </span>
                )}
                {handles}
            </div>
        );
    }

    if (card.kind === "shot" || card.kind === "media") {
        const label = stringField(card.payload, "route") || stringField(card.payload, "label");

        return wrap(
            <>
                <img
                    src={paths.boardsBlob(card.blobKey)}
                    draggable={false}
                    alt={label || `card ${card.id}`}
                    className={`h-full w-full rounded-md object-cover shadow-lg ${ring}`}
                />
                {label ? (
                    <span className="absolute bottom-1 left-1 rounded bg-[color-mix(in_srgb,var(--dd-bg-base)_70%,transparent)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--dd-text-primary)]">
                        {label}
                    </span>
                ) : null}
                {card.currentVersion > 1 && hasPendingAttempt ? (
                    <span
                        title="face advanced by an attempt — verdict pending"
                        className="absolute top-1 right-1 h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--dd-accent-from)]"
                    />
                ) : null}
            </>
        );
    }

    if (card.kind === "note") {
        const color = stringField(card.payload, "color") || "#f7d774";
        const author = stringField(card.payload, "author");

        return wrap(
            <>
                <div ref={bodyRef} className="h-full w-full overflow-auto font-mono text-[13px] leading-[1.5]">
                    {editing ? (
                        <InlineEditor mono initial={editValue} onCommit={(text) => onEditCommit(card, text)} />
                    ) : (
                        stringField(card.payload, "text")
                    )}
                </div>
                {author ? <span className="absolute right-2 bottom-1 text-[9px] opacity-70">{author}</span> : null}
            </>,
            {
                className: `rounded-md p-2.5 whitespace-pre-wrap text-neutral-900 ${ring}`,
                bodyStyle: { background: color },
            }
        );
    }

    if (card.kind === "text") {
        return wrap(
            <div ref={bodyRef} className="h-full w-full overflow-auto">
                {editing ? (
                    <InlineEditor initial={editValue} onCommit={(text) => onEditCommit(card, text)} />
                ) : (
                    <TextCard payload={card.payload} />
                )}
            </div>,
            { className: `rounded-md bg-[var(--dd-bg-panel)] p-2.5 ${ring}` }
        );
    }

    if (card.kind === "callout") {
        return wrap(
            <div ref={bodyRef} className="h-full w-full overflow-auto">
                {editing ? (
                    <InlineEditor initial={editValue} onCommit={(text) => onEditCommit(card, text)} />
                ) : (
                    <CalloutCard payload={card.payload} />
                )}
            </div>,
            { className: `rounded-md ${ring}` }
        );
    }

    if (card.kind === "step") {
        return wrap(<StepCard payload={card.payload} />, { className: `rounded-md bg-[var(--dd-bg-panel)] ${ring}` });
    }

    if (card.kind === "checklist") {
        return wrap(<ChecklistCard payload={card.payload} />, {
            className: `rounded-md bg-[var(--dd-bg-panel)] ${ring}`,
        });
    }

    if (card.kind === "viz") {
        return wrap(<VizCard payload={card.payload} cardId={card.id} onEditCell={onEditCell} />, {
            className: `rounded-md bg-[var(--dd-bg-panel)] ${ring}`,
        });
    }

    if (card.kind === "wireframe") {
        return wrap(<WireframeCard payload={card.payload} />, { className: ring });
    }

    if (card.kind === "shape") {
        return wrap(
            editing ? (
                <InlineEditor initial={editValue} onCommit={(text) => onEditCommit(card, text)} />
            ) : (
                <ShapeCard payload={card.payload} />
            ),
            { className: ring }
        );
    }

    if (card.kind === "compare") {
        return wrap(<CompareRefCard payload={card.payload} />, {
            className: `rounded-md bg-[var(--dd-bg-panel)] ${ring}`,
        });
    }

    if (card.kind === "cluster") {
        return (
            <div style={style} data-card-id={card.id} data-card-kind="cluster" {...editHandlers}>
                <ClusterFrame
                    payload={card.payload}
                    onTitlePointerDown={beginDrag}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                />
                {handles}
            </div>
        );
    }

    return wrap(<span>{card.kind}</span>, {
        className: `flex items-center justify-center rounded-md bg-[var(--dd-bg-panel)] text-xs text-[var(--dd-text-muted)] ${ring}`,
    });
}
