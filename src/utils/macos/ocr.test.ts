import { describe, expect, it } from "bun:test";
import { mergeTiledOcrResults } from "./ocr";

describe("mergeTiledOcrResults", () => {
    it("merges text and re-maps block y from tile-normalized to full-image coords", () => {
        const merged = mergeTiledOcrResults(
            [
                {
                    top: 0,
                    tileHeight: 5000,
                    result: {
                        text: "top line",
                        blocks: [
                            {
                                text: "top line",
                                confidence: 1,
                                bounds: { x: 0.1, y: 0.9, width: 0.2, height: 0.05 },
                            },
                        ],
                    },
                },
                {
                    top: 5000,
                    tileHeight: 2562,
                    result: {
                        text: "bottom line",
                        blocks: [
                            {
                                text: "bottom line",
                                confidence: 1,
                                bounds: { x: 0.1, y: 0.8, width: 0.2, height: 0.04 },
                            },
                        ],
                    },
                },
            ],
            12562
        );

        expect(merged.text).toBe("top line\nbottom line");
        expect(merged.blocks).toHaveLength(2);

        const topBlock = merged.blocks[0];
        const bottomBlock = merged.blocks[1];

        // bottom-left origin: top tile sits at the TOP of the image, so its
        // base is high above the image bottom — block y must include that offset.
        const topTileBottom = (12562 - 0 - 5000) / 12562;
        expect(topBlock.bounds.y).toBeCloseTo(topTileBottom + 0.9 * (5000 / 12562), 5);
        expect(topBlock.bounds.height).toBeCloseTo(0.05 * (5000 / 12562), 5);

        const bottomTileBottom = (12562 - 5000 - 2562) / 12562;
        expect(bottomBlock.bounds.y).toBeCloseTo(bottomTileBottom + 0.8 * (2562 / 12562), 5);
        expect(bottomBlock.bounds.height).toBeCloseTo(0.04 * (2562 / 12562), 5);
    });
});
