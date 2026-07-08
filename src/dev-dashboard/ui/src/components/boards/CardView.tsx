import type { CardDto } from "@app/dev-dashboard/contract/dto";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useRef, useState } from "react";
import {
    CalloutCard,
    ChecklistCard,
    ClusterFrame,
    CompareRefCard,
    ShapeCard,
    StepCard,
    TextCard,
    VizCard,
    WireframeCard,
} from "./AiCards";

interface CardViewProps {
    card: CardDto;
    selected: boolean;
    scale: number;
    hasPendingAttempt: boolean;
    onSelect: (id: number) => void;
    onDragBy: (id: number, dxWorld: number, dyWorld: number) => void;
    onDragEnd: (id: number) => void;
    onNoteChange: (id: number, text: string) => void;
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

export function CardView({
    card,
    selected,
    scale,
    hasPendingAttempt,
    onSelect,
    onDragBy,
    onDragEnd,
    onNoteChange,
    panningRef,
}: CardViewProps) {
    const dragRef = useRef<DragState | null>(null);
    const [editingNote, setEditingNote] = useState(false);
    const [noteDraft, setNoteDraft] = useState(() => stringField(card.payload, "text"));

    const beginDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        // A space-drag pan owns the gesture: don't also start a card drag. The event bubbles to the
        // canvas (we don't capture the pointer), which begins the pan since space is held.
        if (panningRef.current) {
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

    const style: CSSProperties = {
        position: "absolute",
        left: card.x,
        top: card.y,
        width: card.w,
        height: card.h,
        zIndex: card.z,
    };
    const ring = selected ? "ring-2 ring-[var(--dd-accent-from)]" : "ring-1 ring-[var(--dd-border)]";

    if (card.kind === "shot" || card.kind === "media") {
        const label = stringField(card.payload, "route") || stringField(card.payload, "label");

        return (
            <div
                style={style}
                onPointerDown={beginDrag}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
            >
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
            </div>
        );
    }

    if (card.kind === "note") {
        const color = stringField(card.payload, "color") || "#f7d774";
        const author = stringField(card.payload, "author");

        return (
            <div
                style={{ ...style, background: color }}
                className={`overflow-auto rounded-md p-3 text-sm whitespace-pre-wrap text-neutral-900 ${ring}`}
                onPointerDown={editingNote ? undefined : beginDrag}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={() => {
                    setNoteDraft(stringField(card.payload, "text"));
                    setEditingNote(true);
                }}
            >
                {editingNote ? (
                    <textarea
                        autoFocus
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        onBlur={() => {
                            setEditingNote(false);
                            onNoteChange(card.id, noteDraft);
                        }}
                        className="h-full w-full resize-none bg-transparent text-neutral-900 outline-none"
                    />
                ) : (
                    stringField(card.payload, "text")
                )}
                {author ? <span className="absolute right-2 bottom-1 text-[9px] opacity-70">{author}</span> : null}
            </div>
        );
    }

    // Section frames render as always-visible background layers via SectionLayer.tsx, not here.
    if (card.kind === "section") {
        return null;
    }

    if (card.kind === "text") {
        return (
            <div
                style={style}
                className={`dd-markdown overflow-auto rounded-md bg-[var(--dd-bg-panel)] p-3 text-sm ${ring}`}
                onPointerDown={beginDrag}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
            >
                <TextCard payload={card.payload} />
            </div>
        );
    }

    if (card.kind === "callout") {
        return (
            <div
                style={style}
                className={ring}
                onPointerDown={beginDrag}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <CalloutCard payload={card.payload} />
            </div>
        );
    }

    if (card.kind === "step") {
        return (
            <div
                style={style}
                className={`rounded-md bg-[var(--dd-bg-panel)] ${ring}`}
                onPointerDown={beginDrag}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <StepCard payload={card.payload} />
            </div>
        );
    }

    if (card.kind === "checklist") {
        return (
            <div
                style={style}
                className={`rounded-md bg-[var(--dd-bg-panel)] ${ring}`}
                onPointerDown={beginDrag}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <ChecklistCard payload={card.payload} />
            </div>
        );
    }

    if (card.kind === "viz") {
        return (
            <div
                style={style}
                className={`rounded-md bg-[var(--dd-bg-panel)] ${ring}`}
                onPointerDown={beginDrag}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <VizCard payload={card.payload} />
            </div>
        );
    }

    if (card.kind === "wireframe") {
        return (
            <div
                style={style}
                className={ring}
                onPointerDown={beginDrag}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <WireframeCard payload={card.payload} />
            </div>
        );
    }

    if (card.kind === "shape") {
        return (
            <div
                style={style}
                className={ring}
                onPointerDown={beginDrag}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <ShapeCard payload={card.payload} />
            </div>
        );
    }

    if (card.kind === "compare") {
        return (
            <div
                style={style}
                className={`rounded-md bg-[var(--dd-bg-panel)] ${ring}`}
                onPointerDown={beginDrag}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <CompareRefCard payload={card.payload} />
            </div>
        );
    }

    if (card.kind === "cluster") {
        return (
            <div style={style}>
                <ClusterFrame
                    payload={card.payload}
                    onTitlePointerDown={beginDrag}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                />
            </div>
        );
    }

    return (
        <div
            style={style}
            className={`flex items-center justify-center rounded-md bg-[var(--dd-bg-panel)] text-xs text-[var(--dd-text-muted)] ${ring}`}
            onPointerDown={beginDrag}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
        >
            {card.kind}
        </div>
    );
}
