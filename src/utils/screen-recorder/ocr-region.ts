import { type PixelBox, padBox, pixelBox } from "@genesiscz/utils/macos/ocr-boxes";
import type { OcrBlock } from "@genesiscz/utils/macos/types";
import type { RecorderSettings } from "./control";
import type { CapturedFrame, MotionBox } from "./types";

/**
 * Which part of a kept frame OCR reads. The native recorder reports where a kept "change" frame differs from the last
 * kept frame of its display (`motionBoxes`, frame pixels, top-left origin); the previous frame's read tells where text
 * was. From both, a frame can keep the previous text without a read (a small change, or a change with no text in it).
 */

export const OCR_SKIP_REASONS = ["below-threshold", "no-text"] as const;
export type OcrSkipReason = (typeof OCR_SKIP_REASONS)[number];

/** The changed area grows by this many pixels on each side, so a glyph cut by a motion block's edge is read whole. */
export const CHANGED_AREA_PAD_PX = 24;
/** A changed area at least this share of the frame is read as the whole frame: a crop would save little. */
export const CHANGED_AREA_MAX_SHARE = 0.5;

export interface FrameSize {
    width: number;
    height: number;
}

/** The read a frame gets before any OCR call: the whole frame, the previous text, or a check of its changed area. */
export type ReadPlan =
    | { kind: "frame" }
    | { kind: "skip"; reason: OcrSkipReason }
    | { kind: "check-textless"; area: PixelBox };

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

/** The changed area of a frame: the motion boxes joined and padded, inside the frame; undefined when nothing is inside. */
export function changedArea(boxes: MotionBox[], size: FrameSize, pad = CHANGED_AREA_PAD_PX): PixelBox | undefined {
    const inside = boxes
        .map(boxOf)
        .filter((box) => box.width > 0 && box.height > 0 && box.x < size.width && box.y < size.height);
    const joined = unionBox(inside);

    if (!joined) {
        return undefined;
    }

    const padded = padBox(joined, pad, size);
    return area(padded) > 0 ? padded : undefined;
}

/** The previous read's lines that overlap `box`, in frame pixels. */
export function linesOver(blocks: OcrBlock[], box: PixelBox, size: FrameSize): PixelBox[] {
    return blocks
        .filter((block) => block.text.trim().length > 0)
        .map((block) => pixelBox(block.bounds, size))
        .filter((line) => intersects(line, box));
}

/**
 * What a kept frame reads, decided from the frame's motion facts and the previous read of its display. Only a frame
 * that carries motion facts (a capture result's frame: `motionBoxes` set, even when empty) can skip; a streamed frame,
 * a first frame of a capture and a display switch are read whole.
 */
export function planRead(options: {
    frame: Pick<CapturedFrame, "changePercent" | "reason" | "motionBoxes">;
    settings: Pick<RecorderSettings["ocr"], "threshold" | "skipTextless">;
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

    if (!settings.skipTextless || frame.reason !== "change" || frame.motionBoxes.length === 0) {
        return { kind: "frame" };
    }

    const size = options.size();
    const changed = changedArea(frame.motionBoxes, size);

    if (!changed || area(changed) >= CHANGED_AREA_MAX_SHARE * size.width * size.height) {
        return { kind: "frame" };
    }

    // Text was there before: it may have changed, so the frame is read.
    if (linesOver(previous, changed, size).length > 0) {
        return { kind: "frame" };
    }

    return { kind: "check-textless", area: changed };
}
