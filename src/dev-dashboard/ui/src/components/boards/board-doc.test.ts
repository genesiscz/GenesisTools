import { describe, expect, test } from "bun:test";
import type { BoardDocDto, CardDto } from "@app/dev-dashboard/contract/dto";
import {
    patchCardIn,
    recognizeShape,
    removeCard,
    resizeGeom,
    sectionMemberIds,
    swapStroke,
    translatePath,
    upsertCard,
} from "./board-doc";

function card(partial: Partial<CardDto> & { id: number }): CardDto {
    return {
        kind: "note",
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        z: 0,
        payload: {},
        blobKey: "",
        currentVersion: 1,
        ...partial,
    } as CardDto;
}

function doc(partial: Partial<BoardDocDto> = {}): BoardDocDto {
    return {
        cards: [],
        edges: [],
        strokes: [],
        annotations: [],
        questions: [],
        boardMessages: [],
        ...partial,
    } as unknown as BoardDocDto;
}

describe("board-doc upserts", () => {
    test("upsertCard replaces by id, appends on miss", () => {
        const d = doc({ cards: [card({ id: 1, x: 10 })] });
        const replaced = upsertCard(d, card({ id: 1, x: 99 }));
        expect(replaced.cards).toHaveLength(1);
        expect(replaced.cards[0].x).toBe(99);

        const appended = upsertCard(d, card({ id: 2 }));
        expect(appended.cards).toHaveLength(2);
    });

    test("patchCardIn merges partial into the matching card only", () => {
        const d = doc({ cards: [card({ id: 1, x: 10 }), card({ id: 2, x: 20 })] });
        const next = patchCardIn(d, 2, { x: 50, y: 60 });
        expect(next.cards[0].x).toBe(10);
        expect(next.cards[1]).toMatchObject({ x: 50, y: 60 });
    });

    test("removeCard cascades edges, strokes, annotations", () => {
        const d = doc({
            cards: [card({ id: 1 }), card({ id: 2 })],
            edges: [
                { id: 7, fromCard: 1, toCard: 2, toX: 0, toY: 0 },
                { id: 8, fromCard: 2, toCard: null, toX: 5, toY: 5 },
            ],
            strokes: [
                { id: 3, cardId: 1, path: [[0, 0]], color: "#fff", width: 2 },
                { id: 4, cardId: null, path: [[0, 0]], color: "#fff", width: 2 },
            ],
            annotations: [
                { id: 5, cardId: 1 },
                { id: 6, cardId: 2 },
            ],
        } as unknown as Partial<BoardDocDto>);

        const next = removeCard(d, 1);
        expect(next.cards.map((c) => c.id)).toEqual([2]);
        expect(next.edges.map((e) => e.id)).toEqual([8]);
        expect(next.strokes.map((s) => s.id)).toEqual([4]);
        expect(next.annotations.map((a) => a.id)).toEqual([6]);
    });

    test("swapStroke replaces the temp id with the server row", () => {
        const d = doc({
            strokes: [{ id: -1, cardId: null, path: [[0, 0]], color: "#fff", width: 2 }],
        } as unknown as Partial<BoardDocDto>);
        const next = swapStroke(d, -1, {
            id: 42,
            boardId: 1,
            createdBy: "test",
            cardId: null,
            path: [[0, 0]],
            color: "#fff",
            width: 2,
        });
        expect(next.strokes.map((s) => s.id)).toEqual([42]);
    });
});

describe("resizeGeom", () => {
    const orig = { x: 100, y: 100, w: 200, h: 100 };

    test("se grows width and height", () => {
        expect(resizeGeom(orig, "se", 50, 30, false)).toEqual({ x: 100, y: 100, w: 250, h: 130 });
    });

    test("nw shifts origin while resizing", () => {
        expect(resizeGeom(orig, "nw", 20, 10, false)).toEqual({ x: 120, y: 110, w: 180, h: 90 });
    });

    test("clamps to MIN 40", () => {
        const g = resizeGeom(orig, "se", -500, -500, false);
        expect(g.w).toBe(40);
        expect(g.h).toBe(40);
    });

    test("aspect lock keeps ratio", () => {
        const g = resizeGeom(orig, "se", 100, 0, true);
        expect(g.w / g.h).toBeCloseTo(2, 5);
    });
});

describe("sectionMemberIds", () => {
    test("center containment, excludes self and bigger sections", () => {
        const section = card({ id: 1, kind: "section", x: 0, y: 0, w: 400, h: 400 });
        const inside = card({ id: 2, x: 100, y: 100, w: 50, h: 50 });
        const outside = card({ id: 3, x: 500, y: 500, w: 50, h: 50 });
        const nestedSmall = card({ id: 4, kind: "section", x: 10, y: 10, w: 100, h: 100 });
        const overlappingBig = card({ id: 5, kind: "section", x: 50, y: 50, w: 900, h: 900 });

        expect(sectionMemberIds([section, inside, outside, nestedSmall, overlappingBig], section)).toEqual([2, 4]);
    });
});

describe("recognizeShape", () => {
    test("straight stroke → line", () => {
        const points = Array.from({ length: 20 }, (_, i) => [i * 20, i * 10 + (i % 2)]);
        const shape = recognizeShape(points, 1);
        expect(shape?.kind).toBe("line");
    });

    test("closed circle → ellipse", () => {
        const points = Array.from({ length: 40 }, (_, i) => {
            const a = (i / 40) * Math.PI * 2;
            return [Math.cos(a) * 80 + 100, Math.sin(a) * 80 + 100];
        });
        points.push(points[0]);
        expect(recognizeShape(points, 1)?.kind).toBe("ellipse");
    });

    test("closed rectangle path → rect", () => {
        const points: number[][] = [];

        for (let i = 0; i <= 10; i++) {
            points.push([i * 20, 0]);
        }

        for (let i = 0; i <= 10; i++) {
            points.push([200, i * 10]);
        }

        for (let i = 10; i >= 0; i--) {
            points.push([i * 20, 100]);
        }

        for (let i = 10; i >= 0; i--) {
            points.push([0, i * 10]);
        }

        expect(recognizeShape(points, 1)?.kind).toBe("rect");
    });

    test("open scribble stays ink", () => {
        const points = Array.from({ length: 30 }, (_, i) => [i * 10, Math.sin(i) * 60]);
        expect(recognizeShape(points, 1)).toBeNull();
    });

    test("tiny stroke stays ink", () => {
        expect(
            recognizeShape(
                [
                    [0, 0],
                    [4, 4],
                    [8, 2],
                ],
                1
            )
        ).toBeNull();
    });
});

describe("translatePath", () => {
    test("shifts x/y and preserves extra tuple members", () => {
        expect(
            translatePath(
                [
                    [10, 20, 0.5],
                    [30, 40],
                ],
                5,
                -5
            )
        ).toEqual([
            [15, 15, 0.5],
            [35, 35],
        ]);
    });
});
