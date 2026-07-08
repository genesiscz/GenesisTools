import type { BoardDocDto } from "@app/dev-dashboard/contract/dto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { boardsApi } from "./boards-api";
import { CardView } from "./CardView";
import { EdgeLayer } from "./EdgeLayer";
import { fitBounds, panBy, useViewport, zoomAt } from "./useViewport";

interface BoardCanvasProps {
    slug: string;
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

export function BoardCanvas({ slug, doc }: BoardCanvasProps) {
    const { vp, setVp, containerRef, spaceDown } = useViewport();
    const panState = useRef<PanState | null>(null);
    const queryClient = useQueryClient();
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [dragOverrides, setDragOverrides] = useState<Record<number, { x: number; y: number }>>({});

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: ["board", slug] });
    };

    const patchCardMutation = useMutation({
        mutationFn: ({ id, x, y }: { id: number; x: number; y: number }) => boardsApi.patchCard(id, { x, y }),
        onSuccess: (_card, variables) => {
            setDragOverrides((prev) => {
                if (!(variables.id in prev)) {
                    return prev;
                }

                const next = { ...prev };
                delete next[variables.id];
                return next;
            });
            invalidate();
        },
    });

    const deleteCardMutation = useMutation({
        mutationFn: (id: number) => boardsApi.deleteCard(id),
        onSuccess: () => {
            setSelectedId(null);
            invalidate();
        },
    });

    const noteMutation = useMutation({
        mutationFn: ({ id, text }: { id: number; text: string }) => {
            const card = doc.cards.find((c) => c.id === id);
            return boardsApi.patchCard(id, { payload: { ...(card?.payload ?? {}), text } });
        },
        onSuccess: invalidate,
    });

    const pendingAttemptCardIds = useMemo(() => {
        const ids = new Set<number>();

        for (const annotation of doc.annotations) {
            const latest = annotation.attempts[annotation.attempts.length - 1];

            if (latest && latest.verdict === "") {
                ids.add(annotation.cardId);
            }
        }

        return ids;
    }, [doc.annotations]);

    const cards = doc.cards.map((card) => {
        const override = dragOverrides[card.id];
        return override ? { ...card, x: override.x, y: override.y } : card;
    });

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
            } else if ((e.key === "Backspace" || e.key === "Delete") && selectedId != null) {
                e.preventDefault();
                deleteCardMutation.mutate(selectedId);
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
    }, [doc.cards, setVp, containerRef, spaceDown, selectedId, deleteCardMutation]);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        // Pan only from the stage background, or anywhere while Space is held —
        // a card's own pointerdown handler stops this from firing (different target).
        if (e.target !== e.currentTarget && !spaceDown.current) {
            return;
        }

        setSelectedId(null);
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

    const handleDragBy = (id: number, dxWorld: number, dyWorld: number) => {
        setDragOverrides((prev) => {
            const base = prev[id] ?? cards.find((c) => c.id === id);

            if (!base) {
                return prev;
            }

            return { ...prev, [id]: { x: base.x + dxWorld, y: base.y + dyWorld } };
        });
    };

    const handleDragEnd = (id: number) => {
        const override = dragOverrides[id];

        if (override) {
            patchCardMutation.mutate({ id, x: override.x, y: override.y });
        }
    };

    const handleNoteChange = (id: number, text: string) => {
        noteMutation.mutate({ id, text });
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
                {cards.map((card) => (
                    <CardView
                        key={card.id}
                        card={card}
                        selected={selectedId === card.id}
                        scale={vp.scale}
                        hasPendingAttempt={pendingAttemptCardIds.has(card.id)}
                        onSelect={setSelectedId}
                        onDragBy={handleDragBy}
                        onDragEnd={handleDragEnd}
                        onNoteChange={handleNoteChange}
                    />
                ))}
                <EdgeLayer edges={doc.edges} cards={cards} />
            </div>
        </div>
    );
}
