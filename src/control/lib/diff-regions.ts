import type { Annotation, AnnotationRect } from "@genesiscz/utils/image";
import type { DecodedRgba } from "@genesiscz/utils/image/raster";
import pixelmatch from "pixelmatch";

/** One changed area of a screenshot pair, in natural image pixels of image A. */
export interface DiffRegion extends AnnotationRect {
    /** Mismatched pixels inside the region (anti-aliasing excluded, as pixelmatch counts them). */
    pixels: number;
}

export interface DiffRegionOptions {
    /** pixelmatch's per-pixel colour sensitivity, 0..1. */
    threshold: number;
    /** Two changed pixels at most this far apart (px, in x and in y) belong to one region. */
    mergeDistance: number;
    /** A region with fewer mismatched pixels than this is noise and is dropped. */
    minArea: number;
}

export const DEFAULT_REGION_OPTIONS: Omit<DiffRegionOptions, "threshold"> = { mergeDistance: 12, minArea: 24 };

export interface DiffRegionResult {
    mismatchedPixels: number;
    regions: DiffRegion[];
}

/**
 * The changed areas of two same-sized images as bounding boxes: pixelmatch's mismatch mask (anti-aliased pixels are
 * not in it), clustered by a grid of `mergeDistance` cells joined with their 8 neighbours, then boxes closer than
 * `mergeDistance` merged, then regions under `minArea` mismatched pixels dropped. Linear in the pixel count.
 */
export function findDiffRegions(a: DecodedRgba, b: DecodedRgba, options: DiffRegionOptions): DiffRegionResult {
    if (a.width !== b.width || a.height !== b.height) {
        throw new Error(`regions need same-sized images (${a.width}x${a.height} vs ${b.width}x${b.height})`);
    }

    const { width, height } = a;
    const mask = new Uint8ClampedArray(width * height * 4);
    const mismatchedPixels = pixelmatch(a.data, b.data, mask, width, height, {
        threshold: options.threshold,
        diffMask: true,
    });
    if (mismatchedPixels === 0) {
        return { mismatchedPixels, regions: [] };
    }

    return { mismatchedPixels, regions: clusterMask({ mask, width, height, ...options }) };
}

interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    pixels: number;
}

/** Clusters the opaque pixels of a pixelmatch `diffMask` buffer into boxes. */
export function clusterMask({
    mask,
    width,
    height,
    mergeDistance,
    minArea,
}: {
    mask: Uint8ClampedArray;
    width: number;
    height: number;
    mergeDistance: number;
    minArea: number;
}): DiffRegion[] {
    const cell = Math.max(1, Math.floor(mergeDistance));
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    const cells = new Map<number, Box>();

    for (let y = 0; y < height; y++) {
        const rowStart = y * width;
        const cellRow = Math.floor(y / cell) * cols;
        for (let x = 0; x < width; x++) {
            if (mask[(rowStart + x) * 4 + 3] === 0) {
                continue;
            }

            const key = cellRow + Math.floor(x / cell);
            const box = cells.get(key);
            if (box) {
                box.x0 = Math.min(box.x0, x);
                box.x1 = Math.max(box.x1, x);
                box.y1 = y;
                box.pixels++;
            } else {
                cells.set(key, { x0: x, y0: y, x1: x, y1: y, pixels: 1 });
            }
        }
    }

    const seen = new Set<number>();
    const boxes: Box[] = [];
    for (const start of cells.keys()) {
        if (seen.has(start)) {
            continue;
        }

        seen.add(start);
        const stack = [start];
        const merged: Box = { x0: width, y0: height, x1: -1, y1: -1, pixels: 0 };
        for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
            const box = cells.get(key);
            if (!box) {
                continue;
            }

            absorb(merged, box);
            const cx = key % cols;
            const cy = Math.floor(key / cols);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) {
                        continue;
                    }

                    const next = ny * cols + nx;
                    if (!seen.has(next) && cells.has(next)) {
                        seen.add(next);
                        stack.push(next);
                    }
                }
            }
        }
        boxes.push(merged);
    }

    return mergeNearBoxes(boxes, mergeDistance)
        .filter((box) => box.pixels >= minArea)
        .sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0)
        .map((box) => ({ x: box.x0, y: box.y0, w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1, pixels: box.pixels }));
}

function absorb(into: Box, box: Box): void {
    into.x0 = Math.min(into.x0, box.x0);
    into.y0 = Math.min(into.y0, box.y0);
    into.x1 = Math.max(into.x1, box.x1);
    into.y1 = Math.max(into.y1, box.y1);
    into.pixels += box.pixels;
}

/** Merges boxes whose gap is at most `distance` on both axes, until no pair is that close. */
function mergeNearBoxes(boxes: Box[], distance: number): Box[] {
    const list = [...boxes];
    let changed = true;
    while (changed) {
        changed = false;
        list.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
        for (let i = 0; i < list.length && !changed; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const p = list[i];
                const q = list[j];
                if (q.x0 > p.x1 + distance + 1) {
                    break;
                }

                const gapX = Math.max(0, Math.max(p.x0, q.x0) - Math.min(p.x1, q.x1) - 1);
                const gapY = Math.max(0, Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1) - 1);
                if (gapX <= distance && gapY <= distance) {
                    absorb(p, q);
                    list.splice(j, 1);
                    changed = true;
                    break;
                }
            }
        }
    }

    return list;
}

/** Red marks a real change, amber a difference only the data explains (a before/after report's two colours). */
export const CHANGE_COLOR = "#ff5a5f";
export const DATA_COLOR = "#ffb020";

/** The regions as `tools control draw` annotations: one outlined box each, labelled "1", "2", …. */
export function regionAnnotations(
    regions: Array<AnnotationRect & { label?: string }>,
    style: { stroke: string; strokeWidth?: number } = { stroke: CHANGE_COLOR }
): Annotation[] {
    return regions.map((region, index) => ({
        kind: "box",
        rect: { x: region.x, y: region.y, w: region.w, h: region.h },
        style: { stroke: style.stroke, strokeWidth: style.strokeWidth ?? 4 },
        label: { text: region.label ?? String(index + 1), style: { bg: style.stroke } },
    }));
}
