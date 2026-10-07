import pixelmatch from "pixelmatch";
import type { DecodedRgba } from "./raster";

export interface ImageDifference {
    mismatchedPixels: number;
    totalPixels: number;
    differencePct: number;
    similarity: number;
    diff?: Uint8ClampedArray;
}

export function compareImagePixels({
    a,
    b,
    sensitivity = 0.1,
    includeDiff = false,
}: {
    a: DecodedRgba;
    b: DecodedRgba;
    sensitivity?: number;
    includeDiff?: boolean;
}): ImageDifference {
    if (!Number.isFinite(sensitivity) || sensitivity < 0 || sensitivity > 1) {
        throw new Error("Pixel sensitivity must be between 0 and 1");
    }

    for (const image of [a, b]) {
        if (
            !Number.isSafeInteger(image.width) ||
            !Number.isSafeInteger(image.height) ||
            image.width < 1 ||
            image.height < 1 ||
            image.data.length !== image.width * image.height * 4
        ) {
            throw new Error("Image dimensions must match its RGBA buffer");
        }
    }

    if (a.width !== b.width || a.height !== b.height) {
        throw new Error("Image dimensions differ; choose an explicit resize before comparison");
    }

    const totalPixels = a.width * a.height;
    const diff = includeDiff ? new Uint8ClampedArray(totalPixels * 4) : undefined;
    const mismatchedPixels = pixelmatch(a.data, b.data, diff, a.width, a.height, { threshold: sensitivity });
    return {
        mismatchedPixels,
        totalPixels,
        differencePct: (100 * mismatchedPixels) / totalPixels,
        similarity: 1 - mismatchedPixels / totalPixels,
        ...(diff ? { diff } : {}),
    };
}
