import type { BoardDocDto, CardDto, StrokeDto } from "@app/dev-dashboard/contract/dto";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnnotateComposer, type AnnotateSubmitInput } from "./AnnotateComposer";
import { AnnotationLayer, getCardScaleFactor } from "./AnnotationLayer";
import { type Geom, recognizeShape, resizeGeom, sectionMemberIds } from "./board-doc";
import { boardsApi } from "./boards-api";
import { CardView, editableField, type ResizeCorner } from "./CardView";
import { EdgeLayer } from "./EdgeLayer";
import { distanceToPolyline, InkLayer, strokeToWorldPath } from "./InkLayer";
import { AnchoredQuestions, BoardLevelQuestions } from "./QuestionCard";
import { SectionPills } from "./SectionPills";
import { type Tool, Toolbar } from "./Toolbar";
import { useBoardHistory } from "./useBoardHistory";
import { useBoardOps } from "./useBoardOps";
import { fitBounds, panBy, resetZoom, screenToWorld, useViewport, zoomAt } from "./useViewport";

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

type Selection = { kind: "card"; id: number } | { kind: "stroke"; id: number } | { kind: "edge"; id: number };

type Gesture =
    | { kind: "ink"; points: number[][] }
    | { kind: "region"; cardId: number; start: { x: number; y: number }; current: { x: number; y: number } }
    | { kind: "connect"; fromCardId: number; current: { x: number; y: number } }
    | { kind: "section"; start: { x: number; y: number }; current: { x: number; y: number } };

interface PendingRegion {
    cardId: number;
    region: { x: number; y: number; w: number; h: number };
    screenX: number;
    screenY: number;
}

interface CardDragState {
    cardId: number;
    /** Section drags carry members (vitrinka: frame carries its subtree). */
    memberIds: number[];
    start: Map<number, { x: number; y: number }>;
    moved: boolean;
}

interface ResizeState {
    card: CardDto;
    corner: ResizeCorner;
    startClientX: number;
    startClientY: number;
    orig: Geom;
    geom: Geom;
}

interface StrokeDragState {
    stroke: StrokeDto;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    dx: number;
    dy: number;
    moved: boolean;
}

const ERASE_THRESHOLD_SCREEN_PX = 8;
const MIN_SECTION_SIZE = 40;
const INK_COLOR = "#e33352";
const TOOL_KEYS: Record<string, Tool> = {
    v: "move",
    p: "ink",
    a: "annotate",
    n: "note",
    c: "connect",
    s: "section",
    t: "table",
};

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
    const history = useBoardHistory();
    const ops = useBoardOps(slug, history);

    const [selected, setSelected] = useState<Selection | null>(null);
    const [overrides, setOverrides] = useState<Record<number, Partial<Geom>>>({});
    const [gesture, setGesture] = useState<Gesture | null>(null);
    const [pendingRegion, setPendingRegion] = useState<PendingRegion | null>(null);
    const [editingCardId, setEditingCardId] = useState<number | null>(null);
    const [strokeDrag, setStrokeDrag] = useState<StrokeDragState | null>(null);

    const cardDrag = useRef<CardDragState | null>(null);
    const resizeState = useRef<ResizeState | null>(null);
    /** Pre-gesture geometry per override — lets the reconcile effect tell "doc caught up with
     *  our write" apart from "someone else moved the card" (both must drop the override). */
    const overrideBase = useRef(new Map<number, Partial<Geom>>());
    const [, forceRender] = useState(0);

    // Reconcile committed overrides against the doc: an override left in place after a gesture
    // masks the cache, so drop it as soon as the doc matches it (our optimistic write landed) or
    // diverges from BOTH the override and the pre-gesture base (an external move won). Overrides
    // for the ACTIVE gesture (no base entry yet... base is set on commit) stay untouched.
    useEffect(() => {
        setOverrides((prev) => {
            let changed = false;
            const next = { ...prev };

            for (const key of Object.keys(prev)) {
                const cardId = Number(key);
                const base = overrideBase.current.get(cardId);

                if (!base) {
                    continue; // gesture still in progress — never reconcile mid-drag
                }

                const card = doc.cards.find((c) => c.id === cardId);

                if (!card) {
                    overrideBase.current.delete(cardId);
                    delete next[cardId];
                    changed = true;
                    continue;
                }

                const ov = prev[cardId];
                const matches = (field: "x" | "y" | "w" | "h", source: Partial<Geom>) =>
                    source[field] === undefined || card[field] === source[field];
                const docHasOverride = matches("x", ov) && matches("y", ov) && matches("w", ov) && matches("h", ov);
                const docStillAtBase = matches("x", base) && matches("y", base) && matches("w", base) && matches("h", base);

                if (docHasOverride || !docStillAtBase) {
                    overrideBase.current.delete(cardId);
                    delete next[cardId];
                    changed = true;
                }
            }

            return changed ? next : prev;
        });
    }, [doc.cards]);

    const pendingAttemptCardIds = useMemo(() => {
        // A card pulses iff its CURRENT face is an unreviewed attempt (mirrors vitrinka
        // FacePending) — approximated by the newest attempt across the card's annotations.
        const newestByCard = new Map<number, { createdAt: string; verdict: string }>();

        for (const annotation of doc.annotations) {
            const latest = annotation.attempts[annotation.attempts.length - 1];
            if (!latest) {
                continue;
            }
            const prev = newestByCard.get(annotation.cardId);
            if (!prev || latest.createdAt > prev.createdAt) {
                newestByCard.set(annotation.cardId, { createdAt: latest.createdAt, verdict: latest.verdict });
            }
        }

        const ids = new Set<number>();
        for (const [cardId, latest] of newestByCard) {
            if (latest.verdict === "") {
                ids.add(cardId);
            }
        }

        return ids;
    }, [doc.annotations]);

    const cards = useMemo(
        () =>
            doc.cards.map((card) => {
                const override = overrides[card.id];
                return override ? { ...card, ...override } : card;
            }),
        [doc.cards, overrides]
    );

    const selectedCardId = selected?.kind === "card" ? selected.id : null;

    // ------------------------------------------------------------------
    // Clipboard: images become media cards; big text chunks become md cards.
    // ------------------------------------------------------------------
    const pasteRef = useRef<(e: ClipboardEvent) => void>(() => undefined);
    pasteRef.current = (e: ClipboardEvent) => {
        if (isTypingTarget(e.target)) {
            return;
        }

        const el = containerRef.current;
        const center = el ? screenToWorld(vp, el.clientWidth / 2, el.clientHeight / 2) : screenToWorld(vp, 0, 0);
        const items = [...(e.clipboardData?.items ?? [])];
        const images = items
            .filter((i) => i.type.startsWith("image/"))
            .map((i) => i.getAsFile())
            .filter((f): f is File => f !== null);

        if (images.length > 0) {
            e.preventDefault();

            for (const [i, file] of images.entries()) {
                void boardsApi
                    .uploadImage(slug, file, `pasted-${Date.now()}.png`)
                    .then((card) =>
                        boardsApi.patchCard(card.id, {
                            x: Math.round(center.x - card.w / 2 + i * 24),
                            y: Math.round(center.y - card.h / 2 + i * 24),
                        })
                    )
                    .then((card) =>
                        ops.setDoc((d) => ({ ...d, cards: [...d.cards.filter((c) => c.id !== card.id), card] }))
                    )
                    .catch((err) => console.error("[boards] paste image failed", err));
            }

            return;
        }

        const text = e.clipboardData?.getData("text/plain") ?? "";

        if (text.trim().length > 0) {
            e.preventDefault();
            const width = text.length > 600 ? 520 : 360;
            void ops
                .createCard(
                    {
                        kind: "text",
                        x: Math.round(center.x - width / 2),
                        y: Math.round(center.y - 80),
                        w: width,
                        h: 120, // measured-height write-back grows it to fit
                        payload: { md: text, author: operator },
                    },
                    "paste text card"
                )
                .then((card) => setSelected({ kind: "card", id: card.id }));
        }
    };

    useEffect(() => {
        const onPaste = (e: ClipboardEvent) => pasteRef.current(e);
        window.addEventListener("paste", onPaste);
        return () => window.removeEventListener("paste", onPaste);
    }, []);

    // ------------------------------------------------------------------
    // Keyboard: zoom, tools, delete, undo/redo.
    // ------------------------------------------------------------------
    const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
    keyRef.current = (e: KeyboardEvent) => {
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

        if (meta && (e.key === "z" || e.key === "Z")) {
            e.preventDefault();

            if (e.shiftKey) {
                history.redo();
            } else {
                history.undo();
            }

            return;
        }

        if (meta && (e.key === "y" || e.key === "Y")) {
            e.preventDefault();
            history.redo();
            return;
        }

        if (meta && e.key === "0") {
            e.preventDefault();
            if (el) {
                setVp((v) => resetZoom(v, el.clientWidth, el.clientHeight));
            }
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
            setVp(fitBounds(bounds, { width: el.clientWidth, height: el.clientHeight }));
        } else if (e.key === "Escape") {
            setSelected(null);
            setEditingCardId(null);
        } else if ((e.key === "Backspace" || e.key === "Delete") && selected) {
            e.preventDefault();

            if (selected.kind === "card") {
                ops.deleteCard(selected.id);
            } else if (selected.kind === "stroke") {
                const stroke = doc.strokes.find((s) => s.id === selected.id);

                if (stroke) {
                    ops.deleteStroke(stroke);
                }
            } else {
                ops.deleteEdge(selected.id);
            }

            setSelected(null);
        } else if (!meta && !e.shiftKey && TOOL_KEYS[e.key.toLowerCase()]) {
            onToolChange(TOOL_KEYS[e.key.toLowerCase()]);
        }
    };

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => keyRef.current(e);
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
    }, [spaceDown]);

    // ------------------------------------------------------------------
    // Coordinate helpers
    // ------------------------------------------------------------------
    const worldPointFromEvent = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
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

    /** Topmost card at a world point. Sections join only when `includeSections`; they sit at
     *  negative z so any real card above wins the hit. */
    const findCardAt = (point: { x: number; y: number }, includeSections: boolean): CardDto | null => {
        const hits = cards.filter(
            (c) =>
                (includeSections || c.kind !== "section") &&
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
        let closest: StrokeDto | null = null;
        let closestDist = threshold;

        for (const stroke of doc.strokes) {
            const worldPath = strokeToWorldPath(stroke, cardById);
            const dist = distanceToPolyline(point, worldPath);

            if (dist < closestDist) {
                closestDist = dist;
                closest = stroke;
            }
        }

        if (closest) {
            ops.deleteStroke(closest);
        }
    };

    // ------------------------------------------------------------------
    // Pan
    // ------------------------------------------------------------------
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

        setSelected(null);
        setEditingCardId(null);
        beginPan(e);
    };

    // ------------------------------------------------------------------
    // Card drag (move tool) — optimistic override during the gesture, ONE
    // persisted write on drop. Sections carry their members.
    // ------------------------------------------------------------------
    const handleDragBy = (id: number, dxWorld: number, dyWorld: number) => {
        if (!cardDrag.current || cardDrag.current.cardId !== id) {
            const card = cards.find((c) => c.id === id);

            if (!card) {
                return;
            }

            const memberIds = card.kind === "section" ? sectionMemberIds(cards, card) : [];
            const start = new Map<number, { x: number; y: number }>();

            for (const mid of [id, ...memberIds]) {
                const m = cards.find((c) => c.id === mid);

                if (m) {
                    start.set(mid, { x: m.x, y: m.y });
                }
            }

            cardDrag.current = { cardId: id, memberIds, start, moved: false };
        }

        const drag = cardDrag.current;
        drag.moved = true;
        setOverrides((prev) => {
            const next = { ...prev };

            for (const [mid, startPos] of drag.start) {
                const base = next[mid] ?? startPos;
                next[mid] = { x: (base.x ?? startPos.x) + dxWorld, y: (base.y ?? startPos.y) + dyWorld };
            }

            return next;
        });
    };

    const handleDragEnd = (id: number) => {
        const drag = cardDrag.current;
        cardDrag.current = null;

        if (!drag?.moved) {
            return;
        }

        setOverrides((prev) => {
            const moves: Array<{ id: number; x: number; y: number }> = [];
            const next = { ...prev };

            for (const [mid, startPos] of drag.start) {
                const ov = prev[mid];

                if (ov && ov.x !== undefined && ov.y !== undefined) {
                    const rounded = { x: Math.round(ov.x), y: Math.round(ov.y) };
                    moves.push({ id: mid, ...rounded });
                    // Snap the override to the exact values the cache will hold, and remember
                    // the pre-drag base — the reconcile effect clears it once the doc catches
                    // up (react-query notifies subscribers ASYNC; deleting the override here
                    // would show the ORIGINAL position for a frame or more under load).
                    next[mid] = rounded;
                    overrideBase.current.set(mid, startPos);
                }
            }

            if (moves.length === 1) {
                ops.patchGeom(moves[0].id, { x: moves[0].x, y: moves[0].y }, { label: `move card ${id}` });
            } else if (moves.length > 1) {
                ops.moveCards(moves, "move section");
            }

            return next;
        });
    };

    // ------------------------------------------------------------------
    // Resize (8 handles, window-tracked)
    // ------------------------------------------------------------------
    const handleResizeStart = (card: CardDto, corner: ResizeCorner, e: ReactPointerEvent) => {
        e.preventDefault();
        resizeState.current = {
            card,
            corner,
            startClientX: e.clientX,
            startClientY: e.clientY,
            orig: { x: card.x, y: card.y, w: card.w, h: card.h },
            geom: { x: card.x, y: card.y, w: card.w, h: card.h },
        };

        const onMove = (ev: PointerEvent) => {
            const rs = resizeState.current;

            if (!rs) {
                return;
            }

            const dx = (ev.clientX - rs.startClientX) / vp.scale;
            const dy = (ev.clientY - rs.startClientY) / vp.scale;
            const lockAspect = (rs.card.kind === "shot" || rs.card.kind === "media") && !ev.shiftKey;
            rs.geom = resizeGeom(rs.orig, rs.corner, dx, dy, lockAspect);
            setOverrides((prev) => ({ ...prev, [rs.card.id]: { ...rs.geom } }));
        };

        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            const rs = resizeState.current;
            resizeState.current = null;

            if (!rs) {
                return;
            }

            const geom = {
                x: Math.round(rs.geom.x),
                y: Math.round(rs.geom.y),
                w: Math.round(rs.geom.w),
                h: Math.round(rs.geom.h),
            };
            ops.patchGeom(rs.card.id, geom, { label: `resize card ${rs.card.id}` });

            // Hand-sized text opts out of the measured-height repair loop (vitrinka userSized).
            if (editableField(rs.card.kind) === "md" || rs.card.kind === "note") {
                ops.patchPayload(rs.card.id, { ...rs.card.payload, userSized: true }, { record: false });
            }

            // Snap the override to the committed geometry; the reconcile effect clears it once
            // the doc reflects it (see handleDragEnd).
            overrideBase.current.set(rs.card.id, rs.orig);
            setOverrides((prev) => ({ ...prev, [rs.card.id]: geom }));
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    // ------------------------------------------------------------------
    // Inline edit commit (dblclick editors)
    // ------------------------------------------------------------------
    const handleEditCommit = (card: CardDto, text: string) => {
        setEditingCardId(null);
        const field = editableField(card.kind);

        if (!field) {
            return;
        }

        const prev = typeof card.payload[field] === "string" ? (card.payload[field] as string) : "";

        if (text === prev) {
            return;
        }

        if (card.kind === "note" && text.trim() === "") {
            // Emptied note = delete (undoable), vitrinka commitNoteEdit.
            ops.deleteCard(card.id);
            setSelected(null);
            return;
        }

        ops.patchPayload(
            card.id,
            { ...card.payload, [field]: text, ...(card.kind === "text" ? { edited: true } : {}) },
            { label: `edit ${card.kind} ${card.id}` }
        );
    };

    /** Measured-height write-back, debounced per card (vitrinka onContentHeight). */
    const growTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
    const handleContentHeight = (card: CardDto, height: number) => {
        const h = Math.ceil(height);

        if (h <= card.h + 2 || overrides[card.id] || resizeState.current?.card.id === card.id) {
            return;
        }

        const timers = growTimers.current;
        const existing = timers.get(card.id);

        if (existing) {
            clearTimeout(existing);
        }

        timers.set(
            card.id,
            setTimeout(() => {
                timers.delete(card.id);
                ops.patchGeom(card.id, { h }, { record: false });
            }, 600)
        );
    };

    // ------------------------------------------------------------------
    // Stroke selection + drag (move tool)
    // ------------------------------------------------------------------
    const handleStrokePointerDown = (stroke: StrokeDto, e: ReactPointerEvent) => {
        if (tool !== "move" || spaceDown.current) {
            return;
        }

        e.stopPropagation();
        setSelected({ kind: "stroke", id: stroke.id });
        const start = { x: e.clientX, y: e.clientY };
        const state: StrokeDragState = {
            stroke,
            pointerId: e.pointerId,
            startClientX: start.x,
            startClientY: start.y,
            dx: 0,
            dy: 0,
            moved: false,
        };
        setStrokeDrag(state);

        const onMove = (ev: PointerEvent) => {
            state.dx = (ev.clientX - state.startClientX) / vp.scale;
            state.dy = (ev.clientY - state.startClientY) / vp.scale;
            state.moved = state.moved || Math.hypot(state.dx, state.dy) > 2;
            setStrokeDrag({ ...state });
        };

        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setStrokeDrag(null);

            if (state.moved) {
                ops.moveStroke(state.stroke, Math.round(state.dx), Math.round(state.dy));
            }
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    // ------------------------------------------------------------------
    // Overlay gestures (non-move tools)
    // ------------------------------------------------------------------
    const onOverlayPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (spaceDown.current) {
            beginPan(e);
            return;
        }

        const point = worldPointFromEvent(e);

        if (tool === "ink") {
            if (e.button === 2 || (e.button === 0 && e.altKey)) {
                eraseStrokeNear(point);
                return;
            }

            e.currentTarget.setPointerCapture(e.pointerId);
            gestureRef.current = { pointerId: e.pointerId };
            setGesture({ kind: "ink", points: [[point.x, point.y]] });
            return;
        }

        if (tool === "note") {
            void ops
                .createCard(
                    {
                        kind: "note",
                        x: Math.round(point.x),
                        y: Math.round(point.y),
                        w: 230,
                        h: 140,
                        payload: { text: "", author: operator },
                    },
                    "create note"
                )
                .then((card) => {
                    setSelected({ kind: "card", id: card.id });
                    setEditingCardId(card.id);
                    onToolChange("move");
                });
            return;
        }

        if (tool === "table") {
            void ops
                .createCard(
                    {
                        kind: "viz",
                        x: Math.round(point.x),
                        y: Math.round(point.y),
                        w: 360,
                        h: 220,
                        payload: {
                            viz: "table",
                            title: "table",
                            data: {
                                cols: ["·", "·", "·"],
                                rows: [
                                    ["", "", ""],
                                    ["", "", ""],
                                ],
                            },
                        },
                    },
                    "create table"
                )
                .then((card) => {
                    setSelected({ kind: "card", id: card.id });
                    onToolChange("move");
                });
            return;
        }

        if (tool === "annotate") {
            // Any card is annotatable (region in its own box px; images in source px via the
            // scale factor). Empty canvas drops a shape card and annotates it (vitrinka).
            const card = findCardAt(point, true);

            if (!card) {
                e.currentTarget.setPointerCapture(e.pointerId);
                gestureRef.current = { pointerId: e.pointerId };
                setGesture({ kind: "section", start: point, current: point });
                return;
            }

            e.currentTarget.setPointerCapture(e.pointerId);
            gestureRef.current = { pointerId: e.pointerId };
            const local = { x: point.x - card.x, y: point.y - card.y };
            setGesture({ kind: "region", cardId: card.id, start: local, current: local });
            return;
        }

        if (tool === "connect") {
            const card = findCardAt(point, true);

            if (!card) {
                return;
            }

            e.currentTarget.setPointerCapture(e.pointerId);
            gestureRef.current = { pointerId: e.pointerId };
            setGesture({ kind: "connect", fromCardId: card.id, current: point });
            return;
        }

        if (tool === "section") {
            e.currentTarget.setPointerCapture(e.pointerId);
            gestureRef.current = { pointerId: e.pointerId };
            setGesture({ kind: "section", start: point, current: point });
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

            if (g.kind === "connect" || g.kind === "section") {
                return { ...g, current: point };
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
            const path = [...g.points, [endPoint.x, endPoint.y]].map(([x, y]) => [
                Math.round(x * 10) / 10,
                Math.round(y * 10) / 10,
            ]);

            if (path.length < 2) {
                return;
            }

            const shape = recognizeShape(path, vp.scale);

            if (shape && shape.kind !== "line") {
                void ops.createCard(
                    {
                        kind: "shape",
                        x: Math.round(shape.bounds.x),
                        y: Math.round(shape.bounds.y),
                        w: Math.max(MIN_SECTION_SIZE, Math.round(shape.bounds.w)),
                        h: Math.max(MIN_SECTION_SIZE, Math.round(shape.bounds.h)),
                        payload: { shape: shape.kind === "ellipse" ? "ellipse" : "rect", color: INK_COLOR },
                    },
                    "ink shape"
                );
                return;
            }

            if (shape?.kind === "line" && shape.start && shape.end) {
                ops.addStroke({
                    path: [
                        [shape.start.x, shape.start.y],
                        [shape.end.x, shape.end.y],
                    ],
                    color: INK_COLOR,
                    width: 3,
                });
                return;
            }

            ops.addStroke({ path, color: INK_COLOR, width: 3 });
            return;
        }

        if (g.kind === "connect") {
            const target = findCardAt(endPoint, true);

            if (target && target.id !== g.fromCardId) {
                ops.addEdge({ fromCard: g.fromCardId, toCard: target.id });
            } else if (!target) {
                ops.addEdge({ fromCard: g.fromCardId, toX: endPoint.x, toY: endPoint.y });
            }

            return;
        }

        if (g.kind === "section") {
            const minX = Math.min(g.start.x, endPoint.x);
            const minY = Math.min(g.start.y, endPoint.y);
            const w = Math.abs(endPoint.x - g.start.x);
            const h = Math.abs(endPoint.y - g.start.y);

            if (tool === "annotate") {
                // Empty-canvas annotate: drop a shape card sized to the drag, then annotate it.
                if (w < 8 || h < 8) {
                    return;
                }

                void ops
                    .createCard(
                        {
                            kind: "shape",
                            x: Math.round(minX),
                            y: Math.round(minY),
                            w: Math.round(w),
                            h: Math.round(h),
                            payload: { shape: "rect", color: "var(--dd-accent-from)" },
                        },
                        "annotate region"
                    )
                    .then((card) => {
                        const screen = screenPointFromWorld(card.x, card.y + card.h);
                        setPendingRegion({
                            cardId: card.id,
                            region: { x: 0, y: 0, w: card.w, h: card.h },
                            screenX: screen.x,
                            screenY: screen.y,
                        });
                    });
                return;
            }

            if (w >= MIN_SECTION_SIZE && h >= MIN_SECTION_SIZE) {
                void ops
                    .createCard(
                        {
                            kind: "section",
                            x: Math.round(minX),
                            y: Math.round(minY),
                            w: Math.round(w),
                            h: Math.round(h),
                            z: -12,
                            payload: { title: "Section" },
                        },
                        "create section"
                    )
                    .then((card) => {
                        setSelected({ kind: "card", id: card.id });
                        setEditingCardId(card.id);
                        onToolChange("move");
                    });
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
        let minX = Math.min(g.start.x, currentLocal.x);
        let minY = Math.min(g.start.y, currentLocal.y);
        let w = Math.abs(currentLocal.x - g.start.x);
        let h = Math.abs(currentLocal.y - g.start.y);

        if (w < 4 || h < 4) {
            // A plain click annotates the whole card.
            minX = 0;
            minY = 0;
            w = card.w;
            h = card.h;
        }

        const factor = 1 / getCardScaleFactor(card); // source px per world px
        const region = {
            x: Math.round(minX * factor),
            y: Math.round(minY * factor),
            w: Math.round(w * factor),
            h: Math.round(h * factor),
        };
        const screen = screenPointFromWorld(card.x + minX, card.y + minY + h);
        setPendingRegion({ cardId: card.id, region, screenX: screen.x, screenY: screen.y });
    };

    // ------------------------------------------------------------------
    // Annotation + misc actions
    // ------------------------------------------------------------------
    const submitAnnotation = (input: AnnotateSubmitInput) => {
        if (!pendingRegion) {
            return;
        }

        void boardsApi
            .createAnnotation({
                board: slug,
                cardId: pendingRegion.cardId,
                region: pendingRegion.region,
                intent: input.intent,
                intentOther: input.intentOther || undefined,
                prompt: input.prompt,
                createdBy: operator,
            })
            .then((annotation) => {
                setPendingRegion(null);
                ops.setDoc((d) => ({
                    ...d,
                    annotations: [...d.annotations.filter((a) => a.id !== annotation.id), annotation],
                }));
            })
            .catch((err) => console.error("[boards] create annotation failed", err));
    };

    const handleReposition = () => {
        // Snapshot BEFORE positions so ⌘Z can restore the previous layout wholesale.
        const before = doc.cards.map((c) => ({ id: c.id, x: c.x, y: c.y }));

        void boardsApi
            .arrange(slug, { scope: "all", mode: "grid", gap: "M", sort: "reading" })
            .then((res) => {
                // Server emits a layout SSE event; the doc invalidation applies the moves.
                forceRender((n) => n + 1);
                const after = Array.isArray(res.cards)
                    ? res.cards.map((c) => ({ id: c.id, x: c.x, y: c.y }))
                    : [];

                if (after.length === 0) {
                    return;
                }

                history.push({
                    label: "reposition",
                    undo: () => boardsApi.layout(slug, before).then(() => undefined),
                    redo: () => boardsApi.layout(slug, after).then(() => undefined),
                });
            })
            .catch((err) => console.error("[boards] reposition failed", err));
    };

    const handleEditCell = (cardId: number, kind: "col" | "cell", row: number, col: number, text: string) => {
        const card = cards.find((c) => c.id === cardId);

        if (!card) {
            return;
        }

        const data = (typeof card.payload.data === "object" && card.payload.data !== null ? card.payload.data : {}) as {
            cols?: string[];
            rows?: unknown[][];
        };
        const cols = [...(data.cols ?? [])];
        const rows = (data.rows ?? []).map((r) => (Array.isArray(r) ? [...r] : [r]));

        if (kind === "col") {
            if (cols[col] === text) {
                return;
            }

            cols[col] = text;
        } else {
            if (rows[row]?.[col] === text) {
                return;
            }

            if (rows[row]) {
                rows[row][col] = text;
            }
        }

        ops.patchPayload(cardId, { ...card.payload, data: { ...data, cols, rows } }, { label: "edit table cell" });
    };

    const strokeOverrideFor = strokeDrag?.moved
        ? { id: strokeDrag.stroke.id, dx: strokeDrag.dx, dy: strokeDrag.dy }
        : null;

    return (
        <div
            ref={containerRef}
            data-testid="board-canvas"
            className="relative h-full w-full overflow-hidden bg-[var(--dd-bg-base)]"
            style={{
                backgroundImage: "radial-gradient(var(--dd-border) 1px, transparent 1px)",
                backgroundSize: `${28 * vp.scale}px ${28 * vp.scale}px`,
                backgroundPosition: `${vp.x}px ${vp.y}px`,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={(e) => {
                movePan(e);
            }}
            onPointerUp={(e) => {
                endPan(e);
            }}
        >
            <div
                className="absolute top-0 left-0"
                style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})`, transformOrigin: "0 0" }}
            >
                {cards.map((card) => (
                    <CardView
                        key={card.id}
                        card={card}
                        selected={selectedCardId === card.id}
                        scale={vp.scale}
                        tool={tool}
                        hasPendingAttempt={pendingAttemptCardIds.has(card.id)}
                        editing={editingCardId === card.id}
                        onSelect={(id) => setSelected({ kind: "card", id })}
                        onDragBy={handleDragBy}
                        onDragEnd={handleDragEnd}
                        onResizeStart={handleResizeStart}
                        onEditStart={setEditingCardId}
                        onEditCommit={handleEditCommit}
                        onContentHeight={handleContentHeight}
                        onEditCell={handleEditCell}
                        panningRef={spaceDown}
                    />
                ))}
                <EdgeLayer
                    edges={doc.edges}
                    cards={cards}
                    liveEdge={gesture?.kind === "connect" ? gesture : null}
                    selectedEdgeId={selected?.kind === "edge" ? selected.id : null}
                    onSelectEdge={tool === "move" ? (id) => setSelected({ kind: "edge", id }) : undefined}
                />
                <InkLayer
                    strokes={doc.strokes}
                    cards={cards}
                    liveStroke={gesture?.kind === "ink" ? gesture.points : null}
                    selectedStrokeId={selected?.kind === "stroke" ? selected.id : null}
                    dragOverride={strokeOverrideFor}
                    onStrokePointerDown={tool === "move" ? handleStrokePointerDown : undefined}
                />
                <AnnotationLayer
                    annotations={doc.annotations}
                    cards={cards}
                    selectedId={selectedAnnotationId}
                    onSelect={onSelectAnnotation}
                    liveRegion={gesture?.kind === "region" ? gesture : null}
                    onReviseStaged={(id, prompt) => {
                        void boardsApi
                            .reviseAnnotation(id, prompt)
                            .then((a) =>
                                ops.setDoc((d) => ({
                                    ...d,
                                    annotations: d.annotations.map((x) => (x.id === a.id ? a : x)),
                                }))
                            )
                            .catch((err) => console.error("[boards] revise annotation failed", err));
                    }}
                    onDeleteStaged={(id) => {
                        ops.setDoc((d) => ({ ...d, annotations: d.annotations.filter((a) => a.id !== id) }));
                        void boardsApi
                            .deleteAnnotation(id)
                            .catch((err) => console.error("[boards] delete annotation failed", err));
                    }}
                />
                <AnchoredQuestions slug={slug} questions={doc.questions} cards={cards} />
                {gesture?.kind === "section" ? (
                    <div
                        style={{
                            position: "absolute",
                            left: Math.min(gesture.start.x, gesture.current.x),
                            top: Math.min(gesture.start.y, gesture.current.y),
                            width: Math.abs(gesture.current.x - gesture.start.x),
                            height: Math.abs(gesture.current.y - gesture.start.y),
                            pointerEvents: "none",
                        }}
                        className={`rounded-lg border-2 border-dashed ${tool === "annotate" ? "border-[var(--dd-danger)]" : "border-[var(--dd-accent-from)]"}`}
                    />
                ) : null}
            </div>

            <SectionPills
                slug={slug}
                onSelect={(bounds) => {
                    const el = containerRef.current;
                    if (el) {
                        setVp(fitBounds(bounds, { width: el.clientWidth, height: el.clientHeight }));
                    }
                }}
            />
            <BoardLevelQuestions slug={slug} questions={doc.questions} />

            <div
                className="absolute inset-0"
                style={{
                    pointerEvents: tool === "move" ? "none" : "auto",
                    cursor: tool === "move" ? "default" : "crosshair",
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
                    onSubmit={submitAnnotation}
                    onCancel={() => setPendingRegion(null)}
                />
            ) : null}

            <Toolbar tool={tool} onToolChange={onToolChange} onReposition={handleReposition} />
        </div>
    );
}
