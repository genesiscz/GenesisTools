import type { BoardDocDto } from "@app/dev-dashboard/contract/dto";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef } from "react";
import { fitBounds, panBy, useViewport, zoomAt } from "./useViewport";

interface BoardCanvasProps {
    doc: BoardDocDto;
}

interface PanState {
    pointerId: number;
    lastX: number;
    lastY: number;
}

function isTypingTarget(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    );
}

/**
 * The pan/zoom stage. Card/edge/ink/annotation rendering is layered in on top of the
 * world-transformed group by later tasks (23-24) — for now cards render as bare
 * positioned rects so the viewport itself is visually verifiable.
 */
export function BoardCanvas({ doc }: BoardCanvasProps) {
    const { vp, setVp, containerRef, spaceDown } = useViewport();
    const panState = useRef<PanState | null>(null);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (isTypingTarget(e.target)) {
                return;
            }

            if (e.code === "Space") {
                spaceDown.current = true;
            }

            const meta = e.metaKey || e.ctrlKey;
            const el = containerRef.current;
            const cx = el ? el.clientWidth / 2 : 0;
            const cy = el ? el.clientHeight / 2 : 0;

            if (meta && e.key === "0") {
                e.preventDefault();
                setVp({ x: 0, y: 0, scale: 1 });
            } else if (meta && (e.key === "=" || e.key === "+")) {
                e.preventDefault();
                setVp((v) => zoomAt(v, 1.2, cx, cy));
            } else if (meta && e.key === "-") {
                e.preventDefault();
                setVp((v) => zoomAt(v, 1 / 1.2, cx, cy));
            } else if (e.shiftKey && e.key === "!" && el && doc.cards.length > 0) {
                const bounds = doc.cards.reduce(
                    (b, c) => ({
                        minX: Math.min(b.minX, c.x),
                        minY: Math.min(b.minY, c.y),
                        maxX: Math.max(b.maxX, c.x + c.w),
                        maxY: Math.max(b.maxY, c.y + c.h),
                    }),
                    {
                        minX: Number.POSITIVE_INFINITY,
                        minY: Number.POSITIVE_INFINITY,
                        maxX: Number.NEGATIVE_INFINITY,
                        maxY: Number.NEGATIVE_INFINITY,
                    }
                );
                setVp(fitBounds(bounds, el.clientWidth, el.clientHeight));
            }
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.code === "Space") {
                spaceDown.current = false;
            }
        };

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
        };
    }, [doc.cards, setVp, containerRef, spaceDown]);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        // Pan only from the stage background, or anywhere while Space is held —
        // a card's own pointerdown handler (Task 23) stops propagation to opt out.
        if (e.target !== e.currentTarget && !spaceDown.current) {
            return;
        }

        e.currentTarget.setPointerCapture(e.pointerId);
        panState.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const pan = panState.current;

        if (!pan || pan.pointerId !== e.pointerId) {
            return;
        }

        const dx = e.clientX - pan.lastX;
        const dy = e.clientY - pan.lastY;
        pan.lastX = e.clientX;
        pan.lastY = e.clientY;
        setVp((v) => panBy(v, dx, dy));
    };

    const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (panState.current?.pointerId === e.pointerId) {
            panState.current = null;
        }
    };

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full overflow-hidden bg-[var(--dd-bg-base)]"
            style={{
                backgroundImage: "radial-gradient(var(--dd-border) 1px, transparent 1px)",
                backgroundSize: `${28 * vp.scale}px ${28 * vp.scale}px`,
                backgroundPosition: `${vp.x}px ${vp.y}px`,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
        >
            <div
                className="absolute top-0 left-0"
                style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})`, transformOrigin: "0 0" }}
            >
                {doc.cards.map((card) => (
                    <div
                        key={card.id}
                        className="absolute rounded-md bg-[var(--dd-bg-panel)] ring-1 ring-[var(--dd-border)]"
                        style={{ left: card.x, top: card.y, width: card.w, height: card.h, zIndex: card.z }}
                    />
                ))}
            </div>
        </div>
    );
}
