import type { BoardDocDto, CardDto, StrokeDto } from "@app/dev-dashboard/contract/dto";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import {
    type Geom,
    patchCardIn,
    removeCard,
    removeEdge,
    removeStroke,
    swapStroke,
    translatePath,
    upsertCard,
    upsertEdge,
    upsertStroke,
} from "./board-doc";
import { boardsApi } from "./boards-api";
import type { BoardHistory } from "./useBoardHistory";

/** Optimistic board operations: every op updates the react-query cache FIRST (the canvas
 *  re-renders instantly), then persists; on failure the change is rolled back. Undoable ops
 *  record inverse thunks into the history stack. Card ids never change across any op —
 *  deletes are server-side soft deletes reversed via restore. */
export function useBoardOps(slug: string, history: BoardHistory) {
    const queryClient = useQueryClient();
    const tempSeq = useRef(0);
    const queryKey = useMemo(() => ["board", slug] as const, [slug]);

    const setDoc = useCallback(
        (fn: (doc: BoardDocDto) => BoardDocDto) => {
            queryClient.setQueryData<BoardDocDto>(queryKey, (doc) => (doc ? fn(doc) : doc));
        },
        [queryClient, queryKey]
    );

    const getCard = useCallback(
        (id: number): CardDto | undefined =>
            queryClient.getQueryData<BoardDocDto>(queryKey)?.cards.find((c) => c.id === id),
        [queryClient, queryKey]
    );

    /** PATCH geometry with optimistic apply + rollback; optionally records history. */
    const patchGeom = useCallback(
        (id: number, patch: Partial<Geom> & { z?: number }, opts: { record?: boolean; label?: string } = {}) => {
            const prev = getCard(id);

            if (!prev) {
                return;
            }

            const prevGeom = { x: prev.x, y: prev.y, w: prev.w, h: prev.h };
            const apply = (target: Partial<Geom> & { z?: number }) => {
                setDoc((d) => patchCardIn(d, id, target));
                return boardsApi.patchCard(id, target).then(
                    (card) => setDoc((d) => upsertCard(d, card)),
                    (err) => {
                        console.error("[boards] card geometry patch failed — reverting", err);
                        setDoc((d) => patchCardIn(d, id, prevGeom));
                        throw err;
                    }
                );
            };

            if (opts.record !== false) {
                history.push({
                    label: opts.label ?? `move card ${id}`,
                    undo: () => apply(prevGeom).catch(() => undefined),
                    redo: () => apply(patch).catch(() => undefined),
                });
            }

            void apply(patch).catch(() => undefined);
        },
        [getCard, history, setDoc]
    );

    /** Batch move (section-carry / reposition) — ONE history entry, one layout POST. */
    const moveCards = useCallback(
        (moves: Array<{ id: number; x: number; y: number }>, label = "move cards") => {
            const prevMoves = moves
                .map((m) => {
                    const card = getCard(m.id);
                    return card ? { id: m.id, x: card.x, y: card.y } : null;
                })
                .filter((m): m is { id: number; x: number; y: number } => m !== null);

            const apply = (batch: Array<{ id: number; x: number; y: number }>) => {
                setDoc((d) => batch.reduce((acc, m) => patchCardIn(acc, m.id, { x: m.x, y: m.y }), d));
                return boardsApi.layout(slug, batch).then(
                    () => undefined,
                    (err) => {
                        console.error("[boards] layout batch failed — reverting", err);
                        setDoc((d) => prevMoves.reduce((acc, m) => patchCardIn(acc, m.id, { x: m.x, y: m.y }), d));
                        throw err;
                    }
                );
            };

            history.push({
                label,
                undo: () => apply(prevMoves).catch(() => undefined),
                redo: () => apply(moves).catch(() => undefined),
            });
            void apply(moves).catch(() => undefined);
        },
        [getCard, history, setDoc, slug]
    );

    /** Merge-patch a card's payload (note text, section title, md, viz data, userSized...). */
    const patchPayload = useCallback(
        (id: number, payload: Record<string, unknown>, opts: { record?: boolean; label?: string } = {}) => {
            const prev = getCard(id);

            if (!prev) {
                return;
            }

            const prevPayload = prev.payload;
            const apply = (target: Record<string, unknown>) => {
                setDoc((d) => patchCardIn(d, id, { payload: target }));
                return boardsApi.patchCard(id, { payload: target }).then(
                    (card) => setDoc((d) => upsertCard(d, card)),
                    (err) => {
                        console.error("[boards] payload patch failed — reverting", err);
                        setDoc((d) => patchCardIn(d, id, { payload: prevPayload }));
                        throw err;
                    }
                );
            };

            if (opts.record !== false) {
                history.push({
                    label: opts.label ?? `edit card ${id}`,
                    undo: () => apply(prevPayload).catch(() => undefined),
                    redo: () => apply(payload).catch(() => undefined),
                });
            }

            void apply(payload).catch(() => undefined);
        },
        [getCard, history, setDoc]
    );

    const createCard = useCallback(
        async (body: Record<string, unknown>, label = "create card"): Promise<CardDto> => {
            const card = await boardsApi.createCard(slug, body);
            setDoc((d) => upsertCard(d, card));
            history.push({
                label,
                undo: async () => {
                    setDoc((d) => removeCard(d, card.id));
                    await boardsApi.deleteCard(card.id);
                },
                redo: async () => {
                    const restored = await boardsApi.restoreCard(card.id);
                    setDoc((d) => upsertCard(d, restored));
                },
            });
            return card;
        },
        [history, setDoc, slug]
    );

    const deleteCard = useCallback(
        (id: number) => {
            const prev = getCard(id);

            if (!prev) {
                return;
            }

            setDoc((d) => removeCard(d, id));
            void boardsApi.deleteCard(id).then(
                () => undefined,
                (err) => {
                    console.error("[boards] delete failed — reverting", err);
                    setDoc((d) => upsertCard(d, prev));
                }
            );
            history.push({
                label: `delete card ${id}`,
                undo: async () => {
                    const restored = await boardsApi.restoreCard(id);
                    setDoc((d) => upsertCard(d, restored));
                },
                redo: async () => {
                    setDoc((d) => removeCard(d, id));
                    await boardsApi.deleteCard(id);
                },
            });
        },
        [getCard, history, setDoc]
    );

    /** Optimistic ink: temp negative id renders in the SAME frame the live stroke clears
     *  (vitrinka: "pen-up never flickers"), then swaps for the server row; removed on failure. */
    const addStroke = useCallback(
        (stroke: { cardId?: number; path: number[][]; color: string; width: number }) => {
            tempSeq.current -= 1;
            const tempId = tempSeq.current;
            const optimistic = { ...stroke, id: tempId, cardId: stroke.cardId ?? null } as unknown as StrokeDto;
            setDoc((d) => upsertStroke(d, optimistic));

            // The history entry tracks the live id across undo/redo cycles (re-adds mint new ids).
            const ref = { id: tempId };

            void boardsApi.addStrokes(slug, [stroke]).then(
                (res) => {
                    const server = res.strokes[0];

                    if (server) {
                        ref.id = server.id;
                        setDoc((d) => swapStroke(d, tempId, server));
                    }
                },
                (err) => {
                    console.error("[boards] add stroke failed — removing optimistic stroke", err);
                    setDoc((d) => removeStroke(d, tempId));
                }
            );

            history.push({
                label: "draw ink",
                undo: async () => {
                    setDoc((d) => removeStroke(d, ref.id));
                    await boardsApi.deleteStroke(ref.id);
                },
                redo: async () => {
                    const res = await boardsApi.addStrokes(slug, [stroke]);
                    const server = res.strokes[0];

                    if (server) {
                        ref.id = server.id;
                        setDoc((d) => upsertStroke(d, server));
                    }
                },
            });
        },
        [history, setDoc, slug]
    );

    const deleteStrokeOp = useCallback(
        (stroke: StrokeDto) => {
            setDoc((d) => removeStroke(d, stroke.id));
            void boardsApi.deleteStroke(stroke.id).then(
                () => undefined,
                (err) => {
                    console.error("[boards] delete stroke failed — reverting", err);
                    setDoc((d) => upsertStroke(d, stroke));
                }
            );

            const ref = { id: stroke.id };
            const body = {
                cardId: stroke.cardId ?? undefined,
                path: stroke.path,
                color: stroke.color,
                width: stroke.width,
            };
            history.push({
                label: "erase ink",
                undo: async () => {
                    const res = await boardsApi.addStrokes(slug, [body]);
                    const server = res.strokes[0];

                    if (server) {
                        ref.id = server.id;
                        setDoc((d) => upsertStroke(d, server));
                    }
                },
                redo: async () => {
                    setDoc((d) => removeStroke(d, ref.id));
                    await boardsApi.deleteStroke(ref.id);
                },
            });
        },
        [history, setDoc, slug]
    );

    /** Move a whole stroke by a world-space delta (PATCH path; server support required). */
    const moveStroke = useCallback(
        (stroke: StrokeDto, dx: number, dy: number) => {
            const prevPath = stroke.path;
            const nextPath = translatePath(prevPath, dx, dy);
            const apply = (path: number[][]) => {
                setDoc((d) => upsertStroke(d, { ...stroke, path }));
                return boardsApi.patchStroke(stroke.id, { path }).then(
                    (server) => setDoc((d) => upsertStroke(d, server)),
                    (err) => {
                        console.error("[boards] move stroke failed — reverting", err);
                        setDoc((d) => upsertStroke(d, { ...stroke, path: prevPath }));
                        throw err;
                    }
                );
            };

            history.push({
                label: "move ink",
                undo: () => apply(prevPath).catch(() => undefined),
                redo: () => apply(nextPath).catch(() => undefined),
            });
            void apply(nextPath).catch(() => undefined);
        },
        [history, setDoc]
    );

    const addEdge = useCallback(
        (edge: { fromCard: number; toCard?: number; toX?: number; toY?: number }) => {
            void boardsApi.addEdge(slug, edge).then(
                (server) => {
                    setDoc((d) => upsertEdge(d, server));
                    const ref = { id: server.id };
                    history.push({
                        label: "connect",
                        undo: async () => {
                            setDoc((d) => removeEdge(d, ref.id));
                            await boardsApi.deleteEdge(ref.id);
                        },
                        redo: async () => {
                            const again = await boardsApi.addEdge(slug, edge);
                            ref.id = again.id;
                            setDoc((d) => upsertEdge(d, again));
                        },
                    });
                },
                (err) => console.error("[boards] add edge failed", err)
            );
        },
        [history, setDoc, slug]
    );

    const deleteEdge = useCallback(
        (id: number) => {
            const prev = queryClient.getQueryData<BoardDocDto>(queryKey)?.edges.find((e) => e.id === id);
            setDoc((d) => removeEdge(d, id));
            void boardsApi.deleteEdge(id).then(
                () => undefined,
                (err) => {
                    console.error("[boards] delete edge failed — reverting", err);

                    if (prev) {
                        setDoc((d) => upsertEdge(d, prev));
                    }
                }
            );

            if (!prev) {
                return;
            }

            const body = {
                fromCard: prev.fromCard,
                toCard: prev.toCard ?? undefined,
                toX: prev.toCard == null ? prev.toX : undefined,
                toY: prev.toCard == null ? prev.toY : undefined,
                label: prev.label || undefined,
            };
            const ref = { id };
            history.push({
                label: "delete edge",
                undo: async () => {
                    const again = await boardsApi.addEdge(slug, body);
                    ref.id = again.id;
                    setDoc((d) => upsertEdge(d, again));
                },
                redo: async () => {
                    setDoc((d) => removeEdge(d, ref.id));
                    await boardsApi.deleteEdge(ref.id);
                },
            });
        },
        [history, queryClient, queryKey, setDoc, slug]
    );

    return {
        setDoc,
        getCard,
        patchGeom,
        moveCards,
        patchPayload,
        createCard,
        deleteCard,
        addStroke,
        deleteStroke: deleteStrokeOp,
        moveStroke,
        addEdge,
        deleteEdge,
    };
}

export type BoardOps = ReturnType<typeof useBoardOps>;
