import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDarwinKit } from "./darwinkit";
import { mergeRegionOcrResults, mergeTiledOcrResults, planOcrTiles, recognizeText } from "./ocr";
import { boxesHolding, changedLines, frameBoxes, matchingBoxes, type OcrBox, padBox, pixelBox } from "./ocr-boxes";

describe("region tiles", () => {
    it.skipIf(process.platform !== "darwin")(
        "reads two regions of the original image with correction off, without an empty fast retry",
        async () => {
            const image = join(mkdtempSync(join(tmpdir(), "ocr-region-")), "frame.bmp");
            const bitmap = Buffer.alloc(62);
            bitmap.write("BM");
            bitmap.writeUInt32LE(62, 2);
            bitmap.writeUInt32LE(54, 10);
            bitmap.writeUInt32LE(40, 14);
            bitmap.writeInt32LE(2, 18);
            bitmap.writeInt32LE(1, 22);
            bitmap.writeUInt16LE(1, 26);
            bitmap.writeUInt16LE(24, 28);
            writeFileSync(image, bitmap);
            const native = spyOn(getDarwinKit().vision, "ocr").mockResolvedValue({ text: "", blocks: [] });
            try {
                expect(await recognizeText(image, { read: "tiles", languages: ["en-US"] })).toEqual({
                    text: "",
                    blocks: [],
                });
                expect(native).toHaveBeenCalledTimes(2);
                expect(native.mock.calls.map(([request]) => request)).toEqual([
                    {
                        path: image,
                        languages: ["en-US"],
                        level: "accurate",
                        region: { x: 0, y: 0, width: 0.53, height: 1 },
                        language_correction: false,
                    },
                    {
                        path: image,
                        languages: ["en-US"],
                        level: "accurate",
                        region: { x: 0.47, y: 0, width: 0.53, height: 1 },
                        language_correction: false,
                    },
                ]);
                native.mockClear();
                await recognizeText(image, { read: "frame", fastFallback: false });
                expect(native).toHaveBeenCalledWith({ path: image, languages: ["en-US"], level: "accurate" });
            } finally {
                native.mockRestore();
            }
        }
    );

    it("uses two overlapping strips for ultrawide frames, one for ordinary and portrait frames", () => {
        expect(planOcrTiles({ width: 2880, height: 1205 })).toEqual([
            { x: 0, y: 0, width: 0.53, height: 1 },
            { x: 0.47, y: 0, width: 0.53, height: 1 },
        ]);
        expect(planOcrTiles({ width: 2000, height: 1000 })).toHaveLength(2);
        for (const size of [
            { width: 1920, height: 1080 },
            { width: 1440, height: 2560 },
        ]) {
            expect(planOcrTiles(size)).toEqual([{ x: 0, y: 0, width: 1, height: 1 }]);
        }
    });

    it("preserves full-image bounds and repeated text elsewhere, deduplicating only spatially overlapping lines", () => {
        const left = { text: "Seam line", confidence: 0.8, bounds: { x: 0.48, y: 0.7, width: 0.04, height: 0.02 } };
        const duplicate = { ...left, text: "seam  line", confidence: 0.9 };
        const elsewhere = { ...left, bounds: { ...left.bounds, y: 0.3 } };
        const merged = mergeRegionOcrResults([
            { text: left.text, blocks: [left] },
            { text: "seam  line\nSeam line", blocks: [duplicate, elsewhere] },
        ]);
        expect(merged.blocks).toEqual([duplicate, elsewhere]);
        expect(merged.blocks[0].bounds).toEqual(left.bounds);
        expect(merged.text).toBe("seam  line\nSeam line");
        expect(mergeRegionOcrResults([])).toEqual({ text: "", blocks: [] });
    });
});

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

describe("OCR boxes in frame pixels", () => {
    const size = { width: 1000, height: 500 };
    const line = (text: string, x: number, y: number, width = 200, height = 20): OcrBox => ({
        text,
        confidence: 1,
        x,
        y,
        width,
        height,
    });

    it("turns Vision's bottom-left normalized bounds (numbers or strings) into top-left pixels", () => {
        expect(pixelBox({ x: 0.1, y: 0.9, width: 0.2, height: 0.05 }, size)).toEqual({
            x: 100,
            y: 25,
            width: 200,
            height: 25,
        });
        expect(pixelBox({ x: "0.5", y: "0", width: "0.6", height: "0.1" }, size)).toEqual({
            x: 500,
            y: 450,
            width: 500,
            height: 50,
        });
    });

    it("joins lines under each other into a block and keeps a far line apart", () => {
        const boxes = frameBoxes(
            [
                { text: "Účtování 2.0", confidence: 1, bounds: { x: 0.1, y: 0.9, width: 0.2, height: 0.04 } },
                { text: "Novák: pohoda", confidence: 0.5, bounds: { x: 0.1, y: 0.85, width: 0.15, height: 0.04 } },
                { text: "16:31", confidence: 1, bounds: { x: 0.8, y: 0.1, width: 0.05, height: 0.04 } },
                { text: " ", confidence: 1, bounds: { x: 0, y: 0, width: 0.1, height: 0.1 } },
            ],
            size
        );

        expect(boxes.lines).toHaveLength(3);
        expect(boxes.blocks.map((block) => [block.text, block.confidence])).toEqual([
            ["Účtování 2.0\nNovák: pohoda", 0.5],
            ["16:31", 1],
        ]);
        expect(boxes.blocks[0]).toMatchObject({ x: 100, y: 30, width: 200 });
    });

    it("matches without case or diacritics, and a block holds its matched line", () => {
        const lines = [line("Účtování 2.0 - Nacenění", 10, 10), line("Novák", 10, 32), line("Sprint", 600, 400)];
        const blocks = frameBoxes([], size).blocks.concat([{ ...line("block", 0, 0, 300, 60) }]);

        expect(matchingBoxes(lines, "uctovani").map((box) => box.text)).toEqual(["Účtování 2.0 - Nacenění"]);
        expect(matchingBoxes(lines, "  ")).toEqual([]);
        expect(boxesHolding(blocks, matchingBoxes(lines, "novak"))).toHaveLength(1);
        expect(boxesHolding(blocks, matchingBoxes(lines, "sprint"))).toHaveLength(0);
    });

    it("a line Vision read a little differently in the same place is not a change; a new line and a moved new text are", () => {
        const before = [line("Quick views", 60, 240), line("Chat", 60, 280)];
        const after = [
            line("OuIck VewS", 61, 241),
            line("Chat", 400, 100),
            line("Task 3", 740, 259),
            line("Quick reviews", 600, 400),
        ];

        expect(changedLines(before, after).map((box) => box.text)).toEqual(["Task 3", "Quick reviews"]);
        expect(changedLines(undefined, after)).toHaveLength(4);
    });

    it("pads a box and keeps it inside the frame", () => {
        expect(padBox({ x: 5, y: 490, width: 100, height: 8 }, 12, size)).toEqual({
            x: 0,
            y: 478,
            width: 117,
            height: 22,
        });
    });
});
