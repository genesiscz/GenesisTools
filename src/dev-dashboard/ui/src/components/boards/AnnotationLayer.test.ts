import { describe, expect, test } from "bun:test";
import type { CardDto } from "@app/dev-dashboard/contract/dto";
import { regionToWorldRect } from "./AnnotationLayer";

function makeCard(overrides: Partial<CardDto>): CardDto {
    return {
        id: 1,
        boardId: 1,
        kind: "shot",
        x: 0,
        y: 0,
        w: 420,
        h: 907,
        z: 0,
        setRef: "proj/main/s1",
        setVersion: 1,
        filePath: "a.png",
        blobKey: "hash1.png",
        payload: {},
        createdBy: "",
        elemNo: 1,
        currentVersion: 1,
        ...overrides,
    };
}

describe("regionToWorldRect", () => {
    test("scales a source-image-px region down to world px on a downscaled card", () => {
        // A 1290x2796 source screenshot displayed at a 420px-wide card (importSet's IMPORT_CELL_W).
        const card = makeCard({ x: 100, y: 50, w: 420, payload: { naturalWidth: 1290, naturalHeight: 2796 } });
        const rect = regionToWorldRect(card, { x: 129, y: 279, w: 129, h: 100 });

        // factor = card.w / naturalWidth = 420 / 1290
        expect(rect.x).toBeCloseTo(100 + 129 * (420 / 1290), 5);
        expect(rect.y).toBeCloseTo(50 + 279 * (420 / 1290), 5);
        expect(rect.w).toBeCloseTo(129 * (420 / 1290), 5);
        expect(rect.h).toBeCloseTo(100 * (420 / 1290), 5);
    });

    test("falls back to a 1:1 factor when naturalWidth is missing from payload", () => {
        const card = makeCard({ x: 0, y: 0, w: 420, payload: {} });
        const rect = regionToWorldRect(card, { x: 10, y: 20, w: 30, h: 40 });
        expect(rect).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    });
});
