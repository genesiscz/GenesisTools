import type { BoardDocDto, CardDto } from "@app/dev-dashboard/contract/dto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnnotateComposer, type AnnotateSubmitInput } from "./AnnotateComposer";
import { AnnotationLayer } from "./AnnotationLayer";
import { boardsApi } from "./boards-api";
import { CardView } from "./CardView";
import { EdgeLayer } from "./EdgeLayer";
import { distanceToPolyline, InkLayer, strokeToWorldPath } from "./InkLayer";
import { type Tool, Toolbar } from "./Toolbar";
import { fitBounds, panBy, screenToWorld, useViewport, zoomAt } from "./useViewport";

interface BoardCanvasProps {
    slug: string;
    doc: BoardDocDto;
    tool: Tool;
    onToolChange: (tool: Tool) => void;
    operator: string;
    selectedAnnotationId: number | null;
    onSelectAnnotation: (id: number | null) => void;
}

interface PanState {
    pointerId: number;
    lastX: number;
    lastY: number;
}

type Gesture =
    | { kind: "ink"; points: number[][] }
    | { kind: "region"; cardId: number; start: { x: number; y: number }; current: { x: number; y: number } };

interface PendingRegion {
    cardId: number;
    region: { x: number; y: number; w: number; h: number };
    screenX: number;
    screenY: number;
}

const ERASE_THRESHOLD_SCREEN_PX = 8;
const TOOL_KEYS: Record<string, Tool> = { v: "move", p: "ink", a: "annotate", n: "note" };

function isTypingTarget(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    );
}

export function BoardCanvas({
    slug,
    doc,
    tool,
    onToolChange,
    operator,
    selectedAnnotationId,
    onSelectAnnotation,
}: BoardCanvasProps) {
    const { vp, setVp, containerRef, spaceDown } = useViewport();
    const panState = useRef<PanState | null>(null);
    const gestureRef = useRef<{ pointerId: number } | null>(null);
    const queryClient = useQueryClient();
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [dragOverrides, setDragOverrides] = useState<Record<number, { x: number; y: number }>>({});
    const [gesture, setGesture] = useState<Gesture | null>(null);
    const [pendingRegion, setPendingRegion] = useState<PendingRegion | null>(null);

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

    const addStrokeMutation = useMutation({
        mutationFn: (path: number[][]) => boardsApi.addStrokes(slug, [{ path, color: "#e33352", width: 3 }]),
        onSuccess: invalidate,
    });

    const deleteStrokeMutation = useMutation({
        mutationFn: (id: number) => boardsApi.deleteStroke(id),
        onSuccess: invalidate,
    });

    const createAnnotationMutation = useMutation({
        mutationFn: (input: PendingRegion & AnnotateSubmitInput) =>
            boardsApi.createAnnotation({
                board: slug,
                cardId: input.cardId,
                region: input.region,
                intent: input.intent,
                intentOther: input.intentOther || undefined,
                prompt: input.prompt,
                createdBy: operator,
            }),
        onSuccess: () => {
            setPendingRegion(null);
            invalidate();
        },
    });

    const reviseAnnotationMutation = useMutation({
        mutationFn: ({ id, prompt }: { id: number; prompt: string }) => boardsApi.reviseAnnotation(id, prompt),
        onSuccess: invalidate,
    });

    const deleteAnnotationMutation = useMutation({
        mutationFn: (id: number) => boardsApi.deleteAnnotation(id),
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
            } else if (!meta && !e.shiftKey && TOOL_KEYS[e.key.toLowerCase()]) {
                onToolChange(TOOL_KEYS[e.key.toLowerCase()]);
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
    }, [doc.cards, setVp, containerRef, spaceDown, selectedId, deleteCardMutation, onToolChange]);

    const worldPointFromEvent = (e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
        const el = containerRef.current;

        if (!el) {
            return { x: 0, y: 0 };
        }

        const rect = el.getBoundingClientRect();
        return screenToWorld(vp, e.clientX - rect.left, e.clientY - rect.top);
    };

    const screenPointFromWorld = (wx: number, wy: number): { x: number; y: number } => ({
        x: vp.x + wx * vp.scale,
        y: vp.y + wy * vp.scale,
    });

    const findCardAt = (point: { x: number; y: number }): CardDto | null => {
        const hits = cards.filter(
            (c) =>
                (c.kind === "shot" || c.kind === "media") &&
                point.x >= c.x &&
                point.x <= c.x + c.w &&
                point.y >= c.y &&
                point.y <= c.y + c.h
        );
        return hits.length === 0 ? null : hits.reduce((top, c) => (c.z > top.z ? c : top));
    };

    const eraseStrokeNear = (point: { x: number; y: number }) => {
        const cardById = new Map(cards.map((c) => [c.id, c]));
        const threshold = ERASE_THRESHOLD_SCREEN_PX / vp.scale;
        let closestId: number | null = null;
        let closestDist = threshold;

        for (const stroke of doc.strokes) {
            const worldPath = strokeToWorldPath(stroke, cardById);
            const dist = distanceToPolyline(point, worldPath);

            if (dist < closestDist) {
                closestDist = dist;
                closestId = stroke.id;
            }
        }

        if (closestId != null) {
            deleteStrokeMutation.mutate(closestId);
        }
    };

    const beginPan = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        panState.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    };

    const movePan = (e: ReactPointerEvent<HTMLDivElement>): boolean => {
        const pan = panState.current;

        if (!pan || pan.pointerId !== e.pointerId) {
            return false;
        }

        const dx = e.clientX - pan.lastX;
        const dy = e.clientY - pan.lastY;
        pan.lastX = e.clientX;
        pan.lastY = e.clientY;
        setVp((v) => panBy(v, dx, dy));
        return true;
    };

    const endPan = (e: ReactPointerEvent<HTMLDivElement>): boolean => {
        if (panState.current?.pointerId === e.pointerId) {
            panState.current = null;
            return true;
        }

        return false;
    };

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget && !spaceDown.current) {
            return;
        }

        setSelectedId(null);
        beginPan(e);
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        movePan(e);
    };

    const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        endPan(e);
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

    // Shared gesture-capture overlay: a single full-stage plane, active (pointer-events: auto)
    // whenever a non-"move" tool is selected. Distributing ink/annotate pointer handling across
    // per-layer overlays would fight over z-order; one overlay branching on `tool` avoids that.
    const onOverlayPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (spaceDown.current) {
            beginPan(e);
            return;
        }

        if (tool === "ink") {
            const point = worldPointFromEvent(e);

            if (e.button === 2 || (e.button === 0 && e.altKey)) {
                eraseStrokeNear(point);
                return;
            }

            e.currentTarget.setPointerCapture(e.pointerId);
            gestureRef.current = { pointerId: e.pointerId };
            setGesture({ kind: "ink", points: [[point.x, point.y]] });
            return;
        }

        if (tool === "annotate") {
            const point = worldPointFromEvent(e);
            const card = findCardAt(point);

            if (!card) {
                return;
            }

            e.currentTarget.setPointerCapture(e.pointerId);
            gestureRef.current = { pointerId: e.pointerId };
            const local = { x: point.x - card.x, y: point.y - card.y };
            setGesture({ kind: "region", cardId: card.id, start: local, current: local });
        }
    };

    const onOverlayPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (movePan(e)) {
            return;
        }

        if (!gestureRef.current || gestureRef.current.pointerId !== e.pointerId) {
            return;
        }

        const point = worldPointFromEvent(e);
        setGesture((g) => {
            if (!g) {
                return g;
            }

            if (g.kind === "ink") {
                return { ...g, points: [...g.points, [point.x, point.y]] };
            }

            const card = cards.find((c) => c.id === g.cardId);

            if (!card) {
                return g;
            }

            const current = {
                x: Math.max(0, Math.min(card.w, point.x - card.x)),
                y: Math.max(0, Math.min(card.h, point.y - card.y)),
            };
            return { ...g, current };
        });
    };

    const onOverlayPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (endPan(e)) {
            return;
        }

        if (!gestureRef.current || gestureRef.current.pointerId !== e.pointerId) {
            return;
        }

        gestureRef.current = null;
        const g = gesture;
        setGesture(null);

        if (!g) {
            return;
        }

        // Derive the terminal point from this event directly rather than trusting the last
        // pointermove's state update landed first.
        const endPoint = worldPointFromEvent(e);

        if (g.kind === "ink") {
            const path = [...g.points, [endPoint.x, endPoint.y]];

            if (path.length > 1) {
                addStrokeMutation.mutate(path);
            }

            return;
        }

        const card = cards.find((c) => c.id === g.cardId);

        if (!card) {
            return;
        }

        const currentLocal = {
            x: Math.max(0, Math.min(card.w, endPoint.x - card.x)),
            y: Math.max(0, Math.min(card.h, endPoint.y - card.y)),
        };
        const minX = Math.min(g.start.x, currentLocal.x);
        const minY = Math.min(g.start.y, currentLocal.y);
        const w = Math.abs(currentLocal.x - g.start.x);
        const h = Math.abs(currentLocal.y - g.start.y);

        if (w < 4 || h < 4) {
            return;
        }

        const naturalWidth = typeof card.payload.naturalWidth === "number" ? card.payload.naturalWidth : card.w;
        const factor = naturalWidth / card.w; // source px per world px
        const region = {
            x: Math.round(minX * factor),
            y: Math.round(minY * factor),
            w: Math.round(w * factor),
            h: Math.round(h * factor),
        };
        const screen = screenPointFromWorld(card.x + minX, card.y + minY);
        setPendingRegion({ cardId: card.id, region, screenX: screen.x, screenY: screen.y });
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
                        onNoteChange={(id, text) => noteMutation.mutate({ id, text })}
                    />
                ))}
                <EdgeLayer edges={doc.edges} cards={cards} />
                <InkLayer
                    strokes={doc.strokes}
                    cards={cards}
                    liveStroke={gesture?.kind === "ink" ? gesture.points : null}
                />
                <AnnotationLayer
                    annotations={doc.annotations}
                    cards={cards}
                    selectedId={selectedAnnotationId}
                    onSelect={onSelectAnnotation}
                    liveRegion={gesture?.kind === "region" ? gesture : null}
                    onReviseStaged={(id, prompt) => reviseAnnotationMutation.mutate({ id, prompt })}
                    onDeleteStaged={(id) => deleteAnnotationMutation.mutate(id)}
                />
            </div>

            <div
                className="absolute inset-0"
                style={{
                    pointerEvents: tool === "move" ? "none" : "auto",
                    cursor: tool === "annotate" ? "crosshair" : tool === "ink" ? "crosshair" : "default",
                }}
                onPointerDown={onOverlayPointerDown}
                onPointerMove={onOverlayPointerMove}
                onPointerUp={onOverlayPointerUp}
                onContextMenu={(e) => {
                    if (tool === "ink") {
                        e.preventDefault();
                    }
                }}
            />

            {pendingRegion ? (
                <AnnotateComposer
                    screenX={pendingRegion.screenX}
                    screenY={pendingRegion.screenY}
                    onSubmit={(input) => createAnnotationMutation.mutate({ ...pendingRegion, ...input })}
                    onCancel={() => setPendingRegion(null)}
                />
            ) : null}

            <Toolbar tool={tool} onToolChange={onToolChange} />
        </div>
    );
}
