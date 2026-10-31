import { describe, expect, it } from "bun:test";
import type { DecodedRgba } from "@genesiscz/utils/image/raster";
import { clusterMask, DEFAULT_REGION_OPTIONS, findDiffRegions, regionAnnotations } from "./diff-regions";

type Rgb = [number, number, number];

function canvas(width: number, height: number, fill: Rgb): DecodedRgba {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data.set([...fill, 255], i * 4);
    }

    return { width, height, data };
}

function paint(image: DecodedRgba, rect: { x: number; y: number; w: number; h: number }, color: Rgb): DecodedRgba {
    const data = new Uint8ClampedArray(image.data);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
            data.set([...color, 255], (y * image.width + x) * 4);
        }
    }

    return { ...image, data };
}

const options = { threshold: 0.1, ...DEFAULT_REGION_OPTIONS };
const button = { x: 120, y: 80, w: 90, h: 28 };

describe("findDiffRegions", () => {
    it("finds exactly one box around a button that changed colour", () => {
        const screen = paint(canvas(400, 240, [30, 30, 30]), { x: 0, y: 0, w: 400, h: 20 }, [60, 60, 60]);
        const before = paint(screen, button, [40, 90, 200]);
        const after = paint(screen, button, [220, 70, 60]);

        const { regions, mismatchedPixels } = findDiffRegions(before, after, options);

        expect(mismatchedPixels).toBe(button.w * button.h);
        expect(regions).toEqual([{ ...button, pixels: button.w * button.h }]);
    });

    it("reports nothing for identical images and for scattered single-pixel noise", () => {
        const screen = canvas(400, 240, [30, 30, 30]);
        expect(findDiffRegions(screen, screen, options).regions).toEqual([]);

        let noisy = screen;
        for (const [x, y] of [
            [10, 10],
            [200, 50],
            [390, 230],
            [60, 180],
            [300, 120],
        ]) {
            noisy = paint(noisy, { x, y, w: 1, h: 1 }, [90, 90, 90]);
        }

        const { regions, mismatchedPixels } = findDiffRegions(screen, noisy, options);
        expect(mismatchedPixels).toBeGreaterThan(0);
        expect(regions).toEqual([]);
    });

    it("merges changes closer than the merge distance and keeps distant ones apart", () => {
        const screen = canvas(400, 240, [30, 30, 30]);
        const after = paint(
            paint(
                paint(screen, { x: 20, y: 20, w: 10, h: 10 }, [250, 250, 250]),
                { x: 36, y: 20, w: 10, h: 10 },
                [250, 250, 250]
            ),
            { x: 300, y: 200, w: 10, h: 10 },
            [250, 250, 250]
        );

        const regions = findDiffRegions(screen, after, options).regions;

        expect(regions.map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual([
            { x: 20, y: 20, w: 26, h: 10 },
            { x: 300, y: 200, w: 10, h: 10 },
        ]);
    });

    it("drops sparse noise without losing a nearby cluster", () => {
        const width = 256;
        const height = 256;
        const mask = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y += 4) {
            for (let x = 0; x < width; x += 4) {
                mask[(y * width + x) * 4 + 3] = 255;
            }
        }
        mask[(1 * width + 1) * 4 + 3] = 255;

        expect(clusterMask({ mask, width, height, mergeDistance: 0, minArea: 2 })).toEqual([
            { x: 0, y: 0, w: 2, h: 2, pixels: 2 },
        ]);
    });

    it("turns regions into draw annotations", () => {
        expect(regionAnnotations([{ x: 1, y: 2, w: 3, h: 4 }], { stroke: "#ffb020" })).toEqual([
            {
                kind: "box",
                rect: { x: 1, y: 2, w: 3, h: 4 },
                style: { stroke: "#ffb020", strokeWidth: 4 },
                label: { text: "1", style: { bg: "#ffb020" } },
            },
        ]);
    });
});
