/**
 * The native recorder's change check, ported for the meetings-ocr benches: `FrameSignature.changePercent` and
 * `FrameSignature.motionBoxes` with `mergeMotionRegions` from native/ax-tool/SnapshotSupport/FrameSampler.swift. The
 * recorder runs it on raw BGRA before a frame is written; a meeting keeps only JPEGs, so the bench runs it on the
 * decoded JPEGs (the tolerance of 32 is above JPEG noise). The constants are the Swift defaults.
 */

import type { MotionBox } from "@genesiscz/utils/screen-recorder/types";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const STRIDE = 4;
const TOLERANCE = 32;
const BLOCK_SAMPLES = 4;
const MAX_BOXES = 8;

export interface Signature {
    width: number;
    height: number;
    samples: Uint8ClampedArray;
    pixelWidth: number;
    pixelHeight: number;
}

/** Every `STRIDE`th pixel of the image on both axes, four channels each. */
export async function signatureOf(path: string): Promise<Signature> {
    const image = await loadImage(path);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const columns = Math.max(1, Math.floor(image.width / STRIDE));
    const rows = Math.max(1, Math.floor(image.height / STRIDE));
    const samples = new Uint8ClampedArray(columns * rows * 4);
    let out = 0;

    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const at = (row * STRIDE * image.width + column * STRIDE) * 4;
            samples[out] = pixels[at] ?? 0;
            samples[out + 1] = pixels[at + 1] ?? 0;
            samples[out + 2] = pixels[at + 2] ?? 0;
            samples[out + 3] = pixels[at + 3] ?? 0;
            out += 4;
        }
    }

    return { width: columns, height: rows, samples, pixelWidth: image.width, pixelHeight: image.height };
}

function sampleChanged(a: Signature, b: Signature, index: number): boolean {
    const base = index * 4;

    for (let channel = 0; channel < 4; channel++) {
        if (Math.abs((a.samples[base + channel] ?? 0) - (b.samples[base + channel] ?? 0)) > TOLERANCE) {
            return true;
        }
    }

    return false;
}

export function changePercent(current: Signature, previous: Signature): number {
    if (current.width !== previous.width || current.height !== previous.height) {
        return 100;
    }

    const count = current.width * current.height;
    let changed = 0;

    for (let index = 0; index < count; index++) {
        if (sampleChanged(current, previous, index)) {
            changed += 1;
        }
    }

    return (changed * 100) / count;
}

interface BlockRect {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

const unionRect = (a: BlockRect, b: BlockRect): BlockRect => ({
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
});
const overlaps = (a: BlockRect, b: BlockRect) =>
    a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
const rectArea = (rect: BlockRect) => (rect.maxX - rect.minX + 1) * (rect.maxY - rect.minY + 1);

function mergeRegions(regions: BlockRect[], maxBoxes: number): BlockRect[] {
    if (regions.length > 64) {
        return [regions.slice(1).reduce(unionRect, regions[0] as BlockRect)];
    }

    const rects = [...regions];
    let mergedAny = true;

    while (mergedAny) {
        mergedAny = false;

        outer: for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                if (overlaps(rects[i] as BlockRect, rects[j] as BlockRect)) {
                    rects[i] = unionRect(rects[i] as BlockRect, rects[j] as BlockRect);
                    rects.splice(j, 1);
                    mergedAny = true;
                    break outer;
                }
            }
        }
    }

    let result = rects;

    while (result.length > Math.max(1, maxBoxes)) {
        let best = { i: 0, j: 1, cost: Number.POSITIVE_INFINITY };

        for (let i = 0; i < result.length; i++) {
            for (let j = i + 1; j < result.length; j++) {
                const a = result[i] as BlockRect;
                const b = result[j] as BlockRect;
                const cost = rectArea(unionRect(a, b)) - rectArea(a) - rectArea(b);

                if (cost < best.cost) {
                    best = { i, j, cost };
                }
            }
        }

        result[best.i] = unionRect(result[best.i] as BlockRect, result[best.j] as BlockRect);
        result.splice(best.j, 1);
        result = mergeRegions(result, Number.MAX_SAFE_INTEGER);
    }

    return result;
}

/** Where `current` changed against `previous`, in frame pixels, largest first (the Swift order). */
export function motionBoxes(current: Signature, previous: Signature): MotionBox[] {
    if (current.width !== previous.width || current.height !== previous.height) {
        return [[0, 0, current.pixelWidth, current.pixelHeight]];
    }

    const blockColumns = Math.ceil(current.width / BLOCK_SAMPLES);
    const blockRows = Math.ceil(current.height / BLOCK_SAMPLES);
    const changed = new Uint8Array(blockColumns * blockRows);

    for (let row = 0; row < current.height; row++) {
        const blockRow = Math.floor(row / BLOCK_SAMPLES) * blockColumns;

        for (let column = 0; column < current.width; column++) {
            const block = blockRow + Math.floor(column / BLOCK_SAMPLES);

            if (!changed[block] && sampleChanged(current, previous, row * current.width + column)) {
                changed[block] = 1;
            }
        }
    }

    const seen = new Uint8Array(changed.length);
    const regions: BlockRect[] = [];

    for (let start = 0; start < changed.length; start++) {
        if (!changed[start] || seen[start]) {
            continue;
        }

        let rect: BlockRect = {
            minX: start % blockColumns,
            minY: Math.floor(start / blockColumns),
            maxX: start % blockColumns,
            maxY: Math.floor(start / blockColumns),
        };
        const pending = [start];
        seen[start] = 1;

        while (pending.length > 0) {
            const index = pending.pop() as number;
            const x = index % blockColumns;
            const y = Math.floor(index / blockColumns);
            rect = unionRect(rect, { minX: x, minY: y, maxX: x, maxY: y });

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;

                    if (nx < 0 || ny < 0 || nx >= blockColumns || ny >= blockRows) {
                        continue;
                    }

                    const next = ny * blockColumns + nx;

                    if (changed[next] && !seen[next]) {
                        seen[next] = 1;
                        pending.push(next);
                    }
                }
            }
        }

        regions.push(rect);
    }

    const pixelsPerBlock = BLOCK_SAMPLES * STRIDE;
    return mergeRegions(regions, MAX_BOXES)
        .map((rect): MotionBox => {
            const x = rect.minX * pixelsPerBlock;
            const y = rect.minY * pixelsPerBlock;
            return [
                x,
                y,
                Math.min(current.pixelWidth, (rect.maxX + 1) * pixelsPerBlock) - x,
                Math.min(current.pixelHeight, (rect.maxY + 1) * pixelsPerBlock) - y,
            ];
        })
        .sort((a, b) => b[2] * b[3] - a[2] * a[3] || a[1] - b[1] || a[0] - b[0]);
}
