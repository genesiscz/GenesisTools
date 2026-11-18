import type { Annotation, AnnotationRect } from "@genesiscz/utils/image";
import type { DecodedRgba } from "@genesiscz/utils/image/raster";
import { clusterMask, DEFAULT_REGION_OPTIONS, type RegionClusterOptions } from "@genesiscz/utils/image/regions";
import pixelmatch from "pixelmatch";

// The clustering lives in utils so the artifact kit's ImageCompare runs the same code in the browser.
export { clusterMask, DEFAULT_REGION_OPTIONS };

/** One changed area of a screenshot pair, in natural image pixels of image A. */
export interface DiffRegion extends AnnotationRect {
    /** Mismatched pixels inside the region (anti-aliasing excluded, as pixelmatch counts them). */
    pixels: number;
}

export interface DiffRegionOptions extends RegionClusterOptions {
    /** pixelmatch's per-pixel colour sensitivity, 0..1. */
    threshold: number;
}

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
