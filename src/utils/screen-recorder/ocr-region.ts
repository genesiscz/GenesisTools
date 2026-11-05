import { type PixelBox, padBox, pixelBox } from "@genesiscz/utils/macos/ocr-boxes";
import type { OcrBlock, OcrResult } from "@genesiscz/utils/macos/types";
import type { RecorderSettings } from "./control";
import type { CapturedFrame, MotionBox } from "./types";

/**
 * Which part of a kept frame OCR reads. The native recorder reports where a kept "change" frame differs from the last
 * kept frame of its display (`motionBoxes`, frame pixels, top-left origin); the previous frame's read tells where text
 * was. From both, a frame can keep the previous text without a read (a small change, or a change with no text in it),
 * or read only its changed area and put those lines into the previous text (`mergeAreaRead`).
 */

export const OCR_SKIP_REASONS = ["below-threshold", "no-text"] as const;
export type OcrSkipReason = (typeof OCR_SKIP_REASONS)[number];

/** The changed area grows by this many pixels on each side, so a glyph cut by a motion block's edge is read whole. */
export const CHANGED_AREA_PAD_PX = 24;
/** Changed areas that together cover at least this share of the frame are read as the whole frame. */
export const CHANGED_AREA_MAX_SHARE = 0.5;
/** At most this many areas are read apart; more are joined, the pair that adds the least area first. */
export const MAX_CHANGED_AREAS = 4;

export interface FrameSize {
    width: number;
    height: number;
}

/**
 * The read a frame gets before any OCR call: the whole frame, the previous text, or work on its changed area (in frame
 * pixels): a fast check that it holds no text (`checkTextless`), then a read of the area alone (`readArea`) or of the
 * whole frame.
 */
export type ReadPlan =
    | { kind: "frame" }
    | { kind: "skip"; reason: OcrSkipReason }
    | { kind: "area"; areas: PixelBox[]; checkTextless: boolean; readArea: boolean };

function boxOf([x, y, width, height]: MotionBox): PixelBox {
    return { x, y, width, height };
}

function area(box: PixelBox): number {
    return Math.max(0, box.width) * Math.max(0, box.height);
}

export function intersects(a: PixelBox, b: PixelBox): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function unionBox(boxes: PixelBox[]): PixelBox | undefined {
    if (boxes.length === 0) {
        return undefined;
    }

    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    return { x, y, width: right - x, height: bottom - y };
}

/** The previous read's lines that overlap `box`, in frame pixels. */
export function linesOver(blocks: OcrBlock[], box: PixelBox, size: FrameSize): PixelBox[] {
    return blocks
        .filter((block) => block.text.trim().length > 0)
        .map((block) => pixelBox(block.bounds, size))
        .filter((line) => intersects(line, box));
}

/** Joins the areas that overlap, until none does. */
function joinOverlapping(areas: PixelBox[]): PixelBox[] {
    const joined = [...areas];

    for (let i = 0; i < joined.length; i++) {
        for (let j = i + 1; j < joined.length; j++) {
            if (intersects(joined[i] as PixelBox, joined[j] as PixelBox)) {
                joined[i] = unionBox([joined[i] as PixelBox, joined[j] as PixelBox]) as PixelBox;
                joined.splice(j, 1);
                j = i;
            }
        }
    }

    return joined;
}

/**
 * The areas of a frame that OCR reads apart: each motion box padded (`pad`) and grown to hold every line of the
 * previous read it touches, overlapping areas joined, then the pair whose union adds the least area joined until at
 * most `max` remain. Reading the areas apart matters: a frame's changes are scattered (a clock, a chat line, a camera
 * tile), so their joined box covered a median 84% of a meeting's frames while the areas covered about 21%.
 */
export function changedAreas(options: {
    boxes: MotionBox[];
    previous: OcrBlock[];
    size: FrameSize;
    pad?: number;
    max?: number;
}): PixelBox[] {
    const { previous, size } = options;
    const pad = options.pad ?? CHANGED_AREA_PAD_PX;
    const max = Math.max(1, options.max ?? MAX_CHANGED_AREAS);
    const grow = (box: PixelBox) => unionBox([box, ...linesOver(previous, box, size)]) ?? box;
    let areas = options.boxes
        .map(boxOf)
        .filter((box) => box.width > 0 && box.height > 0 && box.x < size.width && box.y < size.height)
        .map((box) => grow(padBox(box, pad, size)));

    // Each pass joins or grows at least one area, and areas never leave the frame, so this ends; the bound is a guard.
    for (let pass = 0; pass < 64; pass++) {
        const joined = joinOverlapping(areas);
        const grown = joined.map(grow);
        const changed = grown.some((box, index) => area(box) !== area(joined[index] as PixelBox));

        if (changed || grown.length !== areas.length) {
            areas = grown;
            continue;
        }

        if (grown.length <= max) {
            return grown;
        }

        let best = { i: 0, j: 1, cost: Number.POSITIVE_INFINITY };

        for (let i = 0; i < grown.length; i++) {
            for (let j = i + 1; j < grown.length; j++) {
                const a = grown[i] as PixelBox;
                const b = grown[j] as PixelBox;
                const cost = area(unionBox([a, b]) as PixelBox) - area(a) - area(b);

                if (cost < best.cost) {
                    best = { i, j, cost };
                }
            }
        }

        areas = grown.filter((_, index) => index !== best.i && index !== best.j);
        areas.push(unionBox([grown[best.i] as PixelBox, grown[best.j] as PixelBox]) as PixelBox);
    }

    return [unionBox(areas) ?? { x: 0, y: 0, width: size.width, height: size.height }];
}

/**
 * What a kept frame reads, decided from the frame's motion facts and the previous read of its display. Only a frame
 * that carries motion facts (a capture result's frame: `motionBoxes` set, even when empty) can skip; a streamed frame,
 * a first frame of a capture and a display switch are read whole.
 */
export function planRead(options: {
    frame: Pick<CapturedFrame, "changePercent" | "reason" | "motionBoxes">;
    settings: Pick<RecorderSettings["ocr"], "threshold" | "skipTextless" | "region">;
    previous: OcrBlock[] | undefined;
    /** The frame's pixel size; read only when the plan needs it. */
    size: () => FrameSize;
}): ReadPlan {
    const { frame, settings, previous } = options;
    const comparable = frame.reason === "change" || frame.reason === "heartbeat";

    if (!previous || !frame.motionBoxes || !comparable) {
        return { kind: "frame" };
    }

    if (settings.threshold > 0 && frame.changePercent < settings.threshold) {
        return { kind: "skip", reason: "below-threshold" };
    }

    const readArea = settings.region === "changed";

    if ((!settings.skipTextless && !readArea) || frame.reason !== "change" || frame.motionBoxes.length === 0) {
        return { kind: "frame" };
    }

    const size = options.size();
    const areas = changedAreas({ boxes: frame.motionBoxes, previous, size });
    const covered = areas.reduce((sum, box) => sum + area(box), 0);

    if (areas.length === 0 || covered >= CHANGED_AREA_MAX_SHARE * size.width * size.height) {
        return { kind: "frame" };
    }

    // Text was there before: it may have changed, so the no-text check cannot skip the frame.
    const checkTextless = settings.skipTextless && areas.every((box) => linesOver(previous, box, size).length === 0);

    if (!checkTextless && !readArea) {
        return { kind: "frame" };
    }

    return { kind: "area", areas, checkTextless, readArea };
}

/** A block read from a crop at `area`, in the whole frame's normalized coordinates (bottom-left origin). */
export function blockInFrame(block: OcrBlock, area: PixelBox, size: FrameSize): OcrBlock {
    const x = Number(block.bounds.x);
    const y = Number(block.bounds.y);
    const width = Number(block.bounds.width);
    const height = Number(block.bounds.height);
    const top = area.y + (1 - y - height) * area.height;
    return {
        ...block,
        bounds: {
            x: (area.x + x * area.width) / size.width,
            y: 1 - (top + height * area.height) / size.height,
            width: (width * area.width) / size.width,
            height: (height * area.height) / size.height,
        },
    };
}

function within(inner: PixelBox, outer: PixelBox): boolean {
    // pixelBox rounds outwards, so a line that ends on the area's edge may stick out by a pixel.
    return (
        inner.x >= outer.x - 1 &&
        inner.y >= outer.y - 1 &&
        inner.x + inner.width <= outer.x + outer.width + 1 &&
        inner.y + inner.height <= outer.y + outer.height + 1
    );
}

/**
 * The frame's text after a read of its changed `area` alone: the previous read's lines that lie inside the area are
 * replaced by the area's lines (moved to frame coordinates), every other line is kept. An area line that overlaps a
 * kept line is a cut-off copy of it and is dropped. The area's lines take the place of the first line they replace,
 * else they go last; the text is the lines joined by newlines, the way Vision writes it.
 */
export function mergeAreaRead(options: {
    previous: OcrResult;
    area: PixelBox;
    read: OcrResult;
    size: FrameSize;
}): OcrResult {
    const { previous, area: box, read, size } = options;
    const kept: OcrBlock[] = [];
    let insertAt: number | undefined;

    for (const block of previous.blocks) {
        if (within(pixelBox(block.bounds, size), box)) {
            insertAt ??= kept.length;
        } else {
            kept.push(block);
        }
    }

    const keptBoxes = kept.map((block) => pixelBox(block.bounds, size));
    const added = read.blocks
        .filter((block) => block.text.trim().length > 0)
        .map((block) => blockInFrame(block, box, size))
        .filter((block) => !keptBoxes.some((line) => intersects(line, pixelBox(block.bounds, size))));
    const at = insertAt ?? kept.length;
    const blocks = [...kept.slice(0, at), ...added, ...kept.slice(at)];
    return { text: blocks.map((block) => block.text).join("\n"), blocks };
}
