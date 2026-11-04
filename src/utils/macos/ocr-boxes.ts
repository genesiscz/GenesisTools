import { readFileSync } from "node:fs";
import { checkImageDimensions } from "@genesiscz/utils/image/dimensions";
import { type OcrOptions, recognizeText } from "./ocr";

/**
 * OCR boxes in frame pixels. Vision reports each recognized text line with bounds normalized to 0..1 and the origin at
 * the bottom left (and darwinkit may send the numbers as strings). These helpers turn them into pixel rectangles with
 * the origin at the top left, the way an image editor, a crop or a canvas counts.
 *
 * - A line box is one Vision observation: a run of text on one baseline ("Microsoft Teams", "View").
 * - A block box joins lines that sit under each other with a small gap and overlap sideways: a paragraph, a list, a
 *   chat bubble, a panel of a window.
 */

export interface PixelBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface OcrBox extends PixelBox {
    text: string;
    confidence: number;
}

export interface FrameBoxes {
    width: number;
    height: number;
    lines: OcrBox[];
    blocks: OcrBox[];
}

/** Vision's block as stored: bounds normalized, origin at the bottom left, numbers or numeric strings. */
export interface NormalizedOcrBlock {
    text: string;
    confidence: number;
    bounds: { x: number | string; y: number | string; width: number | string; height: number | string };
}

export const OCR_BOX_LEVELS = ["line", "block"] as const;
export type OcrBoxLevel = (typeof OCR_BOX_LEVELS)[number];

function num(value: number | string): number {
    return typeof value === "number" ? value : Number(value);
}

/** One normalized Vision rectangle in frame pixels, top-left origin, rounded outwards to whole pixels. */
export function pixelBox(bounds: NormalizedOcrBlock["bounds"], size: { width: number; height: number }): PixelBox {
    const left = num(bounds.x) * size.width;
    const top = (1 - num(bounds.y) - num(bounds.height)) * size.height;
    const right = left + num(bounds.width) * size.width;
    const bottom = top + num(bounds.height) * size.height;
    // A thousandth of a pixel of float error (1 - 0.9 - 0.05) must not move an edge by a whole pixel.
    const floor = (value: number) => Math.floor(value + 1e-3);
    const ceil = (value: number) => Math.ceil(value - 1e-3);
    const x = Math.max(0, floor(left));
    const y = Math.max(0, floor(top));
    return {
        x,
        y,
        width: Math.min(size.width, ceil(right)) - x,
        height: Math.min(size.height, ceil(bottom)) - y,
    };
}

function union(boxes: PixelBox[]): PixelBox {
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    return { x, y, width: right - x, height: bottom - y };
}

/** The share of the narrower box's width that both boxes cover. */
function horizontalOverlap(a: PixelBox, b: PixelBox): number {
    const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    return overlap / Math.max(1, Math.min(a.width, b.width));
}

/**
 * Joins lines into blocks: a line joins a block when it starts below the block's last line by at most `gap` times the
 * line height and overlaps it sideways by at least `overlap` of the narrower width. Lines are taken top to bottom.
 */
export function groupBlocks(lines: OcrBox[], options: { gap?: number; overlap?: number } = {}): OcrBox[] {
    const gap = options.gap ?? 0.8;
    const minOverlap = options.overlap ?? 0.3;
    const ordered = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
    const groups: Array<{ members: OcrBox[]; last: OcrBox }> = [];

    for (const line of ordered) {
        const group = groups.find((one) => {
            const below = line.y - (one.last.y + one.last.height);
            return (
                below >= -one.last.height / 2 &&
                below <= gap * Math.max(line.height, one.last.height) &&
                horizontalOverlap(one.last, line) >= minOverlap
            );
        });

        if (group) {
            group.members.push(line);
            group.last = line;
        } else {
            groups.push({ members: [line], last: line });
        }
    }

    return groups.map(({ members }) => ({
        ...union(members),
        text: members.map((member) => member.text).join("\n"),
        confidence: Math.min(...members.map((member) => member.confidence)),
    }));
}

/** Line and block boxes of one frame's OCR. */
export function frameBoxes(blocks: NormalizedOcrBlock[], size: { width: number; height: number }): FrameBoxes {
    const lines = blocks
        .filter((block) => block.text.trim().length > 0)
        .map((block) => ({ ...pixelBox(block.bounds, size), text: block.text, confidence: block.confidence }))
        .filter((box) => box.width > 0 && box.height > 0);
    return { width: size.width, height: size.height, lines, blocks: groupBlocks(lines) };
}

/** Lowercase, without diacritics and with single spaces: "Účtování  2.0" and "uctovani 2.0" match. */
export function foldText(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

/** The boxes whose text holds `query`, compared without case and diacritics. */
export function matchingBoxes(boxes: OcrBox[], query: string): OcrBox[] {
    const wanted = foldText(query);

    if (!wanted) {
        return [];
    }

    return boxes.filter((box) => foldText(box.text).includes(wanted));
}

function bigrams(text: string): Map<string, number> {
    const grams = new Map<string, number>();

    for (let index = 0; index < text.length - 1; index++) {
        const gram = text.slice(index, index + 2);
        grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }

    return grams;
}

/** Dice similarity of two texts' letter pairs, without case and diacritics: 1 the same, 0 nothing shared. */
export function textSimilarity(a: string, b: string): number {
    const left = foldText(a);
    const right = foldText(b);

    if (left === right) {
        return 1;
    }

    if (left.length < 2 || right.length < 2) {
        return 0;
    }

    const grams = bigrams(left);
    let shared = 0;

    for (const [gram, count] of bigrams(right)) {
        const have = grams.get(gram) ?? 0;
        shared += Math.min(have, count);
    }

    return (2 * shared) / (left.length - 1 + right.length - 1);
}

/** Intersection over union of two boxes. */
export function boxOverlap(a: PixelBox, b: PixelBox): number {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

    if (width <= 0 || height <= 0) {
        return 0;
    }

    const inter = width * height;
    return inter / (a.width * a.height + b.width * b.height - inter);
}

/**
 * The lines of `current` the earlier frame did not show. A line is unchanged when the earlier frame has a line at about
 * the same place (overlap `overlap`, default 0.3) with similar text (`similarity`, default 0.6), or the same text
 * anywhere: Vision reads the same pixels a little differently from frame to frame ("Quick views", "OuIck VewS"), and
 * a scroll moves text without changing it. With no earlier frame every line is new.
 */
export function changedLines(
    previous: OcrBox[] | undefined,
    current: OcrBox[],
    options: { overlap?: number; similarity?: number } = {}
): OcrBox[] {
    if (!previous) {
        return current;
    }

    const minOverlap = options.overlap ?? 0.3;
    const minSimilarity = options.similarity ?? 0.6;
    const seen = new Set(previous.map((box) => foldText(box.text)));
    return current.filter(
        (line) =>
            !seen.has(foldText(line.text)) &&
            !previous.some(
                (before) =>
                    boxOverlap(before, line) >= minOverlap && textSimilarity(before.text, line.text) >= minSimilarity
            )
    );
}

/** The boxes of `boxes` that hold (by their centre) at least one of `lines`. */
export function boxesHolding(boxes: OcrBox[], lines: PixelBox[]): OcrBox[] {
    return boxes.filter((box) =>
        lines.some((line) => {
            const cx = line.x + line.width / 2;
            const cy = line.y + line.height / 2;
            return cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
        })
    );
}

/** A box grown by `pad` pixels on each side, kept inside the frame. */
export function padBox(box: PixelBox, pad: number, size: { width: number; height: number }): PixelBox {
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    return {
        x,
        y,
        width: Math.min(size.width, box.x + box.width + pad) - x,
        height: Math.min(size.height, box.y + box.height + pad) - y,
    };
}

/** The pixel size of a PNG or JPEG from its header (no `sips`, no decode). */
export function imageSize(path: string): { width: number; height: number } {
    return checkImageDimensions({ data: readFileSync(path), maxPixels: Number.MAX_SAFE_INTEGER });
}

/** Reads an image with Vision and returns its text with line and block boxes in its pixels. */
export async function recognizeTextBoxes(
    path: string,
    options: OcrOptions = {}
): Promise<FrameBoxes & { text: string }> {
    const result = await recognizeText(path, options);
    return { text: result.text, ...frameBoxes(result.blocks, imageSize(path)) };
}
