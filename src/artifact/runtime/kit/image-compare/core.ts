import { clusterMask, DEFAULT_REGION_OPTIONS } from "@genesiscz/utils/image/regions";
import pixelmatch from "pixelmatch";

/**
 * The pure half of ImageCompare: image validation, padding to a common size, the pixel diff, and the slider and
 * zoom-pan math. No React and no DOM, so the tests run it directly and a page can reuse it on its own pixels.
 */

/** The diff colour: a pink that reads on light and dark underlays (the look of a design-against-build pixel diff). */
export const IMAGE_DIFF_COLOR = "#ff2d95";
const IMAGE_DIFF_RGB: [number, number, number] = [0xff, 0x2d, 0x95];

/** pixelmatch's colour threshold the kit starts with (a common default for screenshot diffs); 0 is strict, 1 accepts anything. */
export const DEFAULT_DIFF_THRESHOLD = 0.15;
export const DIFF_THRESHOLD_MIN = 0.01;
export const DIFF_THRESHOLD_MAX = 0.5;

export interface CompareSize {
    width: number;
    height: number;
}

export interface CompareRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Decoded pixels, 4 bytes per pixel in RGBA order, row after row. */
export interface RgbaImage extends CompareSize {
    data: Uint8ClampedArray;
}

/** One changed area, in pixels of the common canvas. */
export interface CompareRegion extends CompareRect {
    /** Changed pixels inside the box. */
    pixels: number;
}

export interface ImageDiff {
    /** The common canvas: the larger width and the larger height of the two images. */
    size: CompareSize;
    /** RGBA overlay of the canvas size: IMAGE_DIFF_COLOR where a pixel differs, transparent everywhere else. */
    overlay: Uint8ClampedArray<ArrayBuffer>;
    changed: number;
    total: number;
    regions: CompareRegion[];
    /** The shift of B the diff was computed with; the overlay and the regions are placed for it. */
    shift: Shift;
    /** Pixels inside only one image because the sizes differ (see `coverageRects`); each counts as changed. */
    sizeOnly: number;
}

// ─── Images ───

/** One side of a comparison as the author passes it. */
export interface ImageCompareSide {
    src: string;
    /** Shown on the stage and in the controls. Default: "Before" or "After". */
    label?: string;
    /** Default: the label. */
    alt?: string;
}

/** One entry of `images`; the label is required because there is no before/after to name it. */
export interface ImageCompareItem {
    src: string;
    label: string;
    alt?: string;
}

export interface ResolvedCompareImage {
    src: string;
    label: string;
    alt: string;
}

/** The images of a comparison from its props, or a thrown error that says which prop shape is wrong. */
export function resolveCompareImages({
    before,
    after,
    images,
}: {
    before?: ImageCompareSide;
    after?: ImageCompareSide;
    images?: ImageCompareItem[];
}): ResolvedCompareImage[] {
    if (images !== undefined && (before !== undefined || after !== undefined)) {
        throw new Error("ImageCompare takes `before` and `after`, or `images`, not both.");
    }

    if (images !== undefined) {
        if (images.length < 2) {
            throw new Error(`ImageCompare needs at least two \`images\`; it got ${images.length}.`);
        }

        return images.map((image) => ({ src: image.src, label: image.label, alt: image.alt ?? image.label }));
    }

    if (before === undefined || after === undefined) {
        throw new Error("ImageCompare needs `before` and `after`, or `images` with at least two entries.");
    }

    return [side(before, "Before"), side(after, "After")];
}

function side(image: ImageCompareSide, fallback: string): ResolvedCompareImage {
    const label = image.label ?? fallback;

    return { src: image.src, label, alt: image.alt ?? label };
}

/** "Sizes differ: Before 1280 x 900, After 1280 x 1100", or undefined when the sizes match. */
export function sizesDifferText(
    a: CompareSize & { label: string },
    b: CompareSize & { label: string }
): string | undefined {
    if (a.width === b.width && a.height === b.height) {
        return undefined;
    }

    return `Sizes differ: ${a.label} ${a.width} x ${a.height}, ${b.label} ${b.width} x ${b.height}`;
}

// ─── Pixels ───

/** A whole-pixel offset of B against A: B's content sits at A's position plus (dx, dy). */
export interface Shift {
    dx: number;
    dy: number;
}

export const NO_SHIFT: Shift = { dx: 0, dy: 0 };

/** The canvas both images share: the larger width and the larger height. */
export function commonSize(a: CompareSize, b: CompareSize): CompareSize {
    return { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) };
}

/** The canvas of a pair with A at the origin and B drawn at (-dx, -dy), so B's content lines up with A's. */
export function alignedSize(a: CompareSize, b: CompareSize, shift: Shift): CompareSize {
    return { width: Math.max(a.width, b.width - shift.dx), height: Math.max(a.height, b.height - shift.dy) };
}

/**
 * The image drawn with its top-left corner at `at` on a transparent canvas of `size`, cropped at the canvas edges.
 * The same object when it already fills that canvas from the origin.
 */
export function placeImage(
    image: RgbaImage,
    size: CompareSize,
    at: { x: number; y: number } = { x: 0, y: 0 }
): RgbaImage {
    if (at.x === 0 && at.y === 0 && image.width === size.width && image.height === size.height) {
        return image;
    }

    const data = new Uint8ClampedArray(size.width * size.height * 4);
    const fromX = Math.max(0, -at.x);
    const toX = Math.min(image.width, size.width - at.x);

    for (let y = Math.max(0, -at.y); y < Math.min(image.height, size.height - at.y) && toX > fromX; y++) {
        const row = y * image.width;
        data.set(image.data.subarray((row + fromX) * 4, (row + toX) * 4), ((y + at.y) * size.width + fromX + at.x) * 4);
    }

    return { width: size.width, height: size.height, data };
}

/** Both images on their common canvas, top-left, so pixelmatch can compare them. */
export function padToCommonSize(a: RgbaImage, b: RgbaImage): { a: RgbaImage; b: RgbaImage; size: CompareSize } {
    const size = commonSize(a, b);

    return { a: placeImage(a, size), b: placeImage(b, size), size };
}

/** The part of the aligned canvas both images cover: A at the origin, B moved back by `shift`. */
export function overlapRect(a: CompareSize, b: CompareSize, shift: Shift): CompareRect {
    const x = Math.max(0, -shift.dx);
    const y = Math.max(0, -shift.dy);

    return {
        x,
        y,
        w: Math.max(0, Math.min(a.width, b.width - shift.dx) - x),
        h: Math.max(0, Math.min(a.height, b.height - shift.dy) - y),
    };
}

/** Where A, B, and B at A's size lie on a pair's canvas. */
export interface CoverageRects {
    a: CompareRect;
    b: CompareRect;
    /** B as if it had A's size, at B's place: everything a pure move of the page would cover. */
    bAtSizeOfA: CompareRect;
}

/**
 * The rects that decide which pixel outside the overlap is a change. A pixel inside exactly one image counts as
 * changed when B and B at A's size disagree about it: then the sizes put it there, not the move. The strips a move
 * uncovers (A's rows that B pushed out, B's rows that came in) are where B and B at A's size agree, so they stay
 * out. Unshifted, B at A's size is A itself, and every pixel inside only one image counts.
 */
export function coverageRects(a: CompareSize, b: CompareSize, shift: Shift): CoverageRects {
    return {
        a: { x: 0, y: 0, w: a.width, h: a.height },
        b: { x: -shift.dx, y: -shift.dy, w: b.width, h: b.height },
        bAtSizeOfA: { x: -shift.dx, y: -shift.dy, w: a.width, h: a.height },
    };
}

export function insideRect(rect: CompareRect, x: number, y: number): boolean {
    return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/** True for a pixel inside exactly one image because the sizes differ (see `coverageRects`). */
export function isSizeChange(rects: CoverageRects, x: number, y: number): boolean {
    const inB = insideRect(rects.b, x, y);

    return insideRect(rects.a, x, y) !== inB && inB !== insideRect(rects.bAtSizeOfA, x, y);
}

/**
 * What a pixel mode's share counts, to follow its numbers: nothing to add for an unshifted pair (the whole canvas),
 * the overlap for an aligned pair, and the overlap plus the pixels only one image has when the sizes differ too.
 */
export function comparedAreaText({ shift, sizeOnly }: { shift: Shift; sizeOnly: number }): string {
    if (shift.dx === 0 && shift.dy === 0) {
        return "";
    }

    if (sizeOnly === 0) {
        return " on the aligned pair, where both overlap,";
    }

    return ` on the aligned pair: where both overlap, plus the ${sizeOnly.toLocaleString("en-US")} pixels only one image has because the sizes differ,`;
}

/** The pixels of `rect` (inside the image) as an image of their own. */
function cropImage(image: RgbaImage, rect: CompareRect): RgbaImage {
    const data = new Uint8ClampedArray(rect.w * rect.h * 4);

    for (let y = 0; y < rect.h; y++) {
        const from = ((rect.y + y) * image.width + rect.x) * 4;
        data.set(image.data.subarray(from, from + rect.w * 4), y * rect.w * 4);
    }

    return { width: rect.w, height: rect.h, data };
}

/**
 * pixelmatch over the two images on one canvas: A at the origin, B moved back by `shift` (none by default).
 *
 * Unshifted, the whole canvas is compared, and a pixel inside one image and outside the other counts as changed
 * whatever pixelmatch says, since transparent padding against a white page would otherwise read as equal.
 *
 * Shifted, the overlap is compared, and the pixels only one image has because the sizes differ count as changed
 * (`sizeOnly`, see `coverageRects`); `total` is the overlap plus those. The rows and columns the move uncovers belong
 * to the shift, which is reported as one finding; counted as changes they framed the image and merged every real
 * change into one region the size of the page.
 *
 * Anti-aliased pixels are not changes (pixelmatch's default). Regions come from the same clustering
 * `tools control compare-screenshot` uses.
 */
export function diffImages({
    a,
    b,
    threshold,
    shift = NO_SHIFT,
}: {
    a: RgbaImage;
    b: RgbaImage;
    threshold: number;
    shift?: Shift;
}): ImageDiff {
    const size = alignedSize(a, b, shift);
    const { width, height } = size;
    const overlay = new Uint8ClampedArray(width * height * 4);
    const options = { threshold, diffMask: true, diffColor: IMAGE_DIFF_RGB };
    let changed: number;
    let compared: number;

    if (shift.dx === 0 && shift.dy === 0) {
        const placedA = placeImage(a, size);
        const placedB = placeImage(b, size);
        changed = pixelmatch(placedA.data, placedB.data, overlay, width, height, options);
        compared = width * height;
    } else {
        const area = overlapRect(a, b, shift);
        const part = new Uint8ClampedArray(area.w * area.h * 4);
        changed =
            area.w * area.h === 0
                ? 0
                : pixelmatch(
                      cropImage(a, area).data,
                      cropImage(b, { ...area, x: area.x + shift.dx, y: area.y + shift.dy }).data,
                      part,
                      area.w,
                      area.h,
                      options
                  );

        for (let y = 0; y < area.h; y++) {
            overlay.set(part.subarray(y * area.w * 4, (y + 1) * area.w * 4), ((area.y + y) * width + area.x) * 4);
        }

        compared = area.w * area.h;
    }

    const marks = markSizeChanges({ overlay, size, rects: coverageRects(a, b, shift) });
    changed += marks.added;
    // Unshifted, the whole canvas was compared already; shifted, the size pixels come on top of the overlap.
    const total = shift.dx === 0 && shift.dy === 0 ? compared : compared + marks.sizeOnly;
    const regions = changed === 0 ? [] : clusterMask({ mask: overlay, width, height, ...DEFAULT_REGION_OPTIONS });

    return { size, overlay, changed, total, regions, shift, sizeOnly: marks.sizeOnly };
}

type Span = [number, number];

/** The part of row `y` a rect covers, clipped to the canvas width, or null. */
function rowSpan(rect: CompareRect, y: number, width: number): Span | null {
    if (y < rect.y || y >= rect.y + rect.h) {
        return null;
    }

    const start = Math.max(0, rect.x);
    const end = Math.min(width, rect.x + rect.w);

    return end > start ? [start, end] : null;
}

/** The pixels of a row that exactly one of two spans covers. */
export function exclusiveSpans(p: Span | null, q: Span | null): Span[] {
    if (!p || !q) {
        return [p, q].filter((span): span is Span => span !== null);
    }

    if (p[1] <= q[0] || q[1] <= p[0]) {
        return [p, q];
    }

    const spans: Span[] = [
        [Math.min(p[0], q[0]), Math.max(p[0], q[0])],
        [Math.min(p[1], q[1]), Math.max(p[1], q[1])],
    ];

    return spans.filter(([start, end]) => end > start);
}

/** The spans of row `y` that lie inside exactly one of the two rects (both clipped to the canvas width). */
export function outsideOneSpans({
    a,
    b,
    y,
    width,
}: {
    a: CompareRect;
    b: CompareRect;
    y: number;
    width: number;
}): Span[] {
    return exclusiveSpans(rowSpan(a, y, width), rowSpan(b, y, width));
}

/**
 * Paints every pixel inside only one image because the sizes differ (`coverageRects`). Returns how many there are
 * and how many of them were not painted before.
 */
function markSizeChanges({
    overlay,
    size,
    rects,
}: {
    overlay: Uint8ClampedArray;
    size: CompareSize;
    rects: CoverageRects;
}): { sizeOnly: number; added: number } {
    let sizeOnly = 0;
    let added = 0;

    for (let y = 0; y < size.height; y++) {
        const rowStart = y * size.width;

        for (const [start, end] of outsideOneSpans({ a: rects.a, b: rects.b, y, width: size.width })) {
            for (let x = start; x < end; x++) {
                if (!isSizeChange(rects, x, y)) {
                    continue;
                }

                sizeOnly++;
                const at = (rowStart + x) * 4;

                if (overlay[at + 3] !== 0) {
                    continue;
                }

                overlay[at] = IMAGE_DIFF_RGB[0];
                overlay[at + 1] = IMAGE_DIFF_RGB[1];
                overlay[at + 2] = IMAGE_DIFF_RGB[2];
                overlay[at + 3] = 255;
                added++;
            }
        }
    }

    return { sizeOnly, added };
}

// ─── Alignment ───

/**
 * How far the alignment looks for a shift on each axis, in pixels (ImageCompare's `alignWindow` default). A taller
 * banner moves a page by more than 32 px. Measured in Bun 1.4.2 on a 1280 x 2000 text page moved by (3, 48), 15
 * interleaved rounds: the estimate's median is 36.7 ms at 32 px (which finds a wrong shift), 37.2 ms at 64 px and
 * 37.2 ms at 128 px, so the default is the largest value under 100 ms.
 */
export const ALIGN_WINDOW = 128;
/** How many of the best profile offsets per axis are tried as a shift. */
const PROFILE_CANDIDATES = 3;
/** The winner (a shift, or no shift) must leave at most this share of the runner-up's mean luminance difference. */
const MAX_ALIGNED_RESIDUAL = 0.6;

/** Luminance of one pixel, blended over white by its alpha. */
function luminance(data: Uint8ClampedArray, at: number): number {
    const alpha = data[at + 3] / 255;

    return (0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2]) * alpha + 255 * (1 - alpha);
}

/** Mean luminance of every row and of every column: the projection profiles. */
export function projectionProfiles(image: RgbaImage): { rows: Float64Array; cols: Float64Array } {
    const rows = new Float64Array(image.height);
    const cols = new Float64Array(image.width);

    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const value = luminance(image.data, (y * image.width + x) * 4);
            rows[y] += value;
            cols[x] += value;
        }
    }

    for (let y = 0; y < image.height; y++) {
        rows[y] /= Math.max(1, image.width);
    }

    for (let x = 0; x < image.width; x++) {
        cols[x] /= Math.max(1, image.height);
    }

    return { rows, cols };
}

/**
 * The offsets d in [-window, window] at which `b[i + d]` follows `a[i]` best: the highest local peaks of the
 * normalised correlation over at least half of the shorter profile, best first. Empty when the profiles are flat
 * (that axis carries no evidence).
 */
function profileOffsets(a: Float64Array, b: Float64Array, window: number): number[] {
    const minOverlap = Math.max(8, Math.floor(Math.min(a.length, b.length) / 2));
    const scores = new Map<number, number>();

    for (let d = -window; d <= window; d++) {
        const start = Math.max(0, -d);
        const end = Math.min(a.length, b.length - d);
        const n = end - start;

        if (n < minOverlap) {
            continue;
        }

        let sumA = 0;
        let sumB = 0;

        for (let i = start; i < end; i++) {
            sumA += a[i];
            sumB += b[i + d];
        }

        const meanA = sumA / n;
        const meanB = sumB / n;
        let cov = 0;
        let varA = 0;
        let varB = 0;

        for (let i = start; i < end; i++) {
            const p = a[i] - meanA;
            const q = b[i + d] - meanB;
            cov += p * q;
            varA += p * p;
            varB += q * q;
        }

        if (varA >= 1e-6 * n && varB >= 1e-6 * n) {
            scores.set(d, cov / Math.sqrt(varA * varB));
        }
    }

    const peaks = [...scores].filter(
        ([d, score]) => score >= (scores.get(d - 1) ?? -2) && score >= (scores.get(d + 1) ?? -2)
    );

    return peaks
        .sort((p, q) => q[1] - p[1] || Math.abs(p[0]) - Math.abs(q[0]))
        .slice(0, PROFILE_CANDIDATES)
        .map(([d]) => d);
}

/** Mean absolute luminance difference of A and B moved back by `shift`, over their overlap (every second pixel). */
function meanDifference(a: RgbaImage, b: RgbaImage, shift: Shift): number {
    let total = 0;
    let count = 0;

    for (let y = Math.max(0, -shift.dy); y < Math.min(a.height, b.height - shift.dy); y += 2) {
        for (let x = Math.max(0, -shift.dx); x < Math.min(a.width, b.width - shift.dx); x += 2) {
            total += Math.abs(
                luminance(a.data, (y * a.width + x) * 4) -
                    luminance(b.data, ((y + shift.dy) * b.width + x + shift.dx) * 4)
            );
            count++;
        }
    }

    return count === 0 ? Number.POSITIVE_INFINITY : total / count;
}

/**
 * One whole-pixel offset of B against A within `window` px either way: the projection-profile approach, where a moved page is
 * one finding instead of a smear of changed pixels. The row and column projection profiles only propose offsets (their
 * best peaks per axis); the pixels decide. A page's column profile is mostly its text, so a few real changes can pull
 * that correlation low even when the shift is plain to see, and a correlation gate rejected such a pair.
 *
 * Returns the shift that leaves clearly the smallest mean luminance difference: a non-zero one only when it beats the
 * unmoved pair, { dx: 0, dy: 0 } only when the unmoved pair beats every proposed shift. Null when nothing wins clearly
 * (an unrelated pair), so such a pair never gets a wrong offset.
 */
export function estimateShift(a: RgbaImage, b: RgbaImage, window = ALIGN_WINDOW): Shift | null {
    const profileA = projectionProfiles(a);
    const profileB = projectionProfiles(b);
    const xs = new Set([0, ...profileOffsets(profileA.cols, profileB.cols, window)]);
    const ys = new Set([0, ...profileOffsets(profileA.rows, profileB.rows, window)]);
    const unmoved = meanDifference(a, b, NO_SHIFT);
    let best: { shift: Shift; residual: number } | null = null;

    for (const dx of xs) {
        for (const dy of ys) {
            if (dx === 0 && dy === 0) {
                continue;
            }

            const residual = meanDifference(a, b, { dx, dy });

            if (!best || residual < best.residual) {
                best = { shift: { dx, dy }, residual };
            }
        }
    }

    if (!best || unmoved <= MAX_ALIGNED_RESIDUAL * best.residual) {
        return { dx: 0, dy: 0 };
    }

    return best.residual <= MAX_ALIGNED_RESIDUAL * unmoved ? best.shift : null;
}

function signed(value: number): string {
    return value > 0 ? `+${value}` : String(value);
}

/** "After is shifted by +3, +12 px". */
export function shiftText(shift: Shift, label = "B"): string {
    return `${label} is shifted by ${signed(shift.dx)}, ${signed(shift.dy)} px`;
}

/** "1.24% of pixels differ (31,452)", or "No pixels differ". */
export function diffSummary(diff: Pick<ImageDiff, "changed" | "total">): string {
    if (diff.changed === 0) {
        return "No pixels differ";
    }

    const share = (diff.changed / diff.total) * 100;
    const percent = share < 0.01 ? "<0.01" : share >= 10 ? share.toFixed(1) : share.toFixed(2);

    return `${percent}% of pixels differ (${diff.changed.toLocaleString("en-US")})`;
}

// ─── Slider ───

export function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, value));
}

/** The slider position after a key, or undefined when the key does not move it. Shift makes a step 10% instead of 2%. */
export function sliderKeyPercent({
    key,
    shift,
    value,
}: {
    key: string;
    shift: boolean;
    value: number;
}): number | undefined {
    const step = shift ? 10 : 2;

    if (key === "ArrowLeft" || key === "ArrowDown") {
        return clampPercent(value - step);
    }

    if (key === "ArrowRight" || key === "ArrowUp") {
        return clampPercent(value + step);
    }

    if (key === "Home") {
        return 0;
    }

    if (key === "End") {
        return 100;
    }

    return undefined;
}

/** What a key does while a comparison has focus. */
export type CompareKeyAction =
    | { kind: "mode"; index: number }
    | { kind: "zoom"; factor: number }
    | { kind: "fit" }
    | { kind: "step-b"; by: number };

/** 1 to 9 pick a mode by position, + and - zoom (= and _ too, for a key without Shift), 0 fits, [ and ] step B. */
export function compareKey(key: string): CompareKeyAction | undefined {
    if (/^[1-9]$/.test(key)) {
        return { kind: "mode", index: Number(key) - 1 };
    }

    if (key === "+" || key === "=") {
        return { kind: "zoom", factor: ZOOM_STEP };
    }

    if (key === "-" || key === "_") {
        return { kind: "zoom", factor: 1 / ZOOM_STEP };
    }

    if (key === "0") {
        return { kind: "fit" };
    }

    if (key === "[" || key === "]") {
        return { kind: "step-b", by: key === "]" ? 1 : -1 };
    }

    return undefined;
}

/** The slider position under a pointer, as a percentage of the stage width. */
export function percentAt({ clientX, left, width }: { clientX: number; left: number; width: number }): number {
    if (width <= 0) {
        return 50;
    }

    return clampPercent(((clientX - left) / width) * 100);
}

// ─── Zoom and pan ───

/** What every pane of a comparison shows: a scale and the canvas point at the pane centre. */
export interface CompareView {
    /** Screen pixels per image pixel; null is the first view: the whole canvas, centred across, top edge at the top. */
    scale: number | null;
    cx: number;
    cy: number;
}

/** A pane's resolved placement: the canvas is drawn at (x, y) in pane pixels, scaled by `scale`. */
export interface ViewTransform {
    scale: number;
    x: number;
    y: number;
}

export const FIT_VIEW: CompareView = { scale: null, cx: 0, cy: 0 };
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 32;
/** One press of a zoom button. */
export const ZOOM_STEP = 1.25;

/** The scale that shows the whole canvas; never above 1, so a small image keeps its real pixels. */
export function fitScale(pane: CompareSize, canvas: CompareSize): number {
    if (pane.width <= 0 || pane.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
        return 1;
    }

    return Math.min(1, pane.width / canvas.width, pane.height / canvas.height);
}

/** The pane height for a canvas: its height at the width the pane fits it to, capped at `maxHeight`. */
export function paneHeight({
    canvas,
    width,
    maxHeight,
}: {
    canvas: CompareSize;
    width: number;
    maxHeight: number;
}): number {
    if (canvas.width <= 0 || width <= 0) {
        return Math.min(maxHeight, canvas.height);
    }

    // Rounded up, so a pane never ends a fraction of a pixel short of the image it fits.
    return Math.max(1, Math.ceil(Math.min(maxHeight, canvas.height * Math.min(1, width / canvas.width))));
}

/**
 * Keeps a scale between the zoom limits. The lower limit is ZOOM_MIN, or the fit scale when that is smaller (a long
 * screenshot), so zooming out from the whole image never zooms in.
 */
function clampScale({ scale, pane, canvas }: { scale: number; pane: CompareSize; canvas: CompareSize }): number {
    return Math.min(ZOOM_MAX, Math.max(Math.min(ZOOM_MIN, fitScale(pane, canvas)), scale));
}

/**
 * Keeps the canvas covering the pane on an axis where it is larger. Where it is smaller it sits like the first view:
 * centred across, top edge at the top.
 */
function clampCentre(view: CompareView, pane: CompareSize, canvas: CompareSize): CompareView {
    if (view.scale === null) {
        return view;
    }

    const halfW = pane.width / (2 * view.scale);
    const halfH = pane.height / (2 * view.scale);
    const cx = canvas.width <= 2 * halfW ? canvas.width / 2 : Math.min(canvas.width - halfW, Math.max(halfW, view.cx));
    const cy = canvas.height <= 2 * halfH ? halfH : Math.min(canvas.height - halfH, Math.max(halfH, view.cy));

    return { scale: view.scale, cx, cy };
}

export function resolveView(view: CompareView, pane: CompareSize, canvas: CompareSize): ViewTransform {
    if (view.scale === null) {
        const scale = fitScale(pane, canvas);

        return { scale, x: (pane.width - canvas.width * scale) / 2, y: 0 };
    }

    return {
        scale: view.scale,
        x: pane.width / 2 - view.cx * view.scale,
        y: pane.height / 2 - view.cy * view.scale,
    };
}

/** Zooms by `factor` keeping the canvas point under `point` (pane pixels) where it is. */
export function zoomViewAt({
    view,
    pane,
    canvas,
    factor,
    point,
}: {
    view: CompareView;
    pane: CompareSize;
    canvas: CompareSize;
    factor: number;
    point: { x: number; y: number };
}): CompareView {
    const now = resolveView(view, pane, canvas);
    const scale = clampScale({ scale: now.scale * factor, pane, canvas });
    const px = (point.x - now.x) / now.scale;
    const py = (point.y - now.y) / now.scale;
    const x = point.x - px * scale;
    const y = point.y - py * scale;

    return clampCentre({ scale, cx: (pane.width / 2 - x) / scale, cy: (pane.height / 2 - y) / scale }, pane, canvas);
}

/** Zooms by `factor` around the pane centre (the zoom buttons). */
export function zoomViewBy({
    view,
    pane,
    canvas,
    factor,
}: {
    view: CompareView;
    pane: CompareSize;
    canvas: CompareSize;
    factor: number;
}): CompareView {
    return zoomViewAt({ view, pane, canvas, factor, point: { x: pane.width / 2, y: pane.height / 2 } });
}

/** Real pixels (scale 1). The row at the top of the pane stays there, so 100% from the first view keeps the top edge. */
export function actualSizeView(view: CompareView, pane: CompareSize, canvas: CompareSize): CompareView {
    const now = resolveView(view, pane, canvas);

    return zoomViewAt({ view, pane, canvas, factor: 1 / now.scale, point: { x: pane.width / 2, y: 0 } });
}

/** Moves the canvas by (dx, dy) pane pixels, as a drag does. */
export function panView({
    view,
    pane,
    canvas,
    dx,
    dy,
}: {
    view: CompareView;
    pane: CompareSize;
    canvas: CompareSize;
    dx: number;
    dy: number;
}): CompareView {
    const now = resolveView(view, pane, canvas);
    const cx = (pane.width / 2 - now.x) / now.scale - dx / now.scale;
    const cy = (pane.height / 2 - now.y) / now.scale - dy / now.scale;

    return clampCentre({ scale: now.scale, cx, cy }, pane, canvas);
}

/** True when the canvas at this view is larger than the pane on some axis, so a drag has something to move. */
export function canPan(view: CompareView, pane: CompareSize, canvas: CompareSize): boolean {
    const { scale } = resolveView(view, pane, canvas);

    return canvas.width * scale > pane.width + 0.5 || canvas.height * scale > pane.height + 0.5;
}

/** The view that shows `rect` whole with `padding` pane pixels around it, at no more than 8x. */
export function viewForRect({
    rect,
    pane,
    canvas,
    padding = 24,
}: {
    rect: CompareRect;
    pane: CompareSize;
    canvas: CompareSize;
    padding?: number;
}): CompareView {
    const scale = clampScale({
        scale: Math.min(
            8,
            (pane.width - 2 * padding) / Math.max(1, rect.w),
            (pane.height - 2 * padding) / Math.max(1, rect.h)
        ),
        pane,
        canvas,
    });

    return clampCentre({ scale, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 }, pane, canvas);
}

// ─── Region marks ───

/** Height of a region number in the gutter beside the stage, in screen pixels. */
export const GUTTER_LABEL_HEIGHT = 16;
/** Space between two numbers in the gutter. */
const GUTTER_LABEL_GAP = 2;

/** A region's number in the gutter, and where its leader line meets the box. */
export interface GutterLabel {
    /** The region's index in the diff's list. */
    index: number;
    /** Pane y of the number's top edge; the gutter starts at the pane's top. */
    top: number;
    /** Pane point the leader ends at: the box's right edge, half way down the part of the box in view. */
    anchor: { x: number; y: number };
}

/**
 * Where each region's number goes in the gutter at the right of the stage, so no number ever covers an image pixel:
 * level with its box where there is room, in box order from the top, at least one number's height apart, and inside
 * the pane's height. A box out of view gets no number.
 */
export function gutterLabels({
    regions,
    transform,
    pane,
}: {
    regions: CompareRect[];
    transform: ViewTransform;
    pane: CompareSize;
}): GutterLabel[] {
    const labels = regions
        .map((region, index) => {
            const top = transform.y + region.y * transform.scale;
            const left = transform.x + region.x * transform.scale;

            return {
                index,
                top,
                bottom: top + region.h * transform.scale,
                left,
                right: left + region.w * transform.scale,
            };
        })
        .filter((box) => box.bottom > 0 && box.top < pane.height && box.right > 0 && box.left < pane.width)
        .map((box): GutterLabel => {
            const y = (Math.max(0, box.top) + Math.min(pane.height, box.bottom)) / 2;

            return {
                index: box.index,
                top: y - GUTTER_LABEL_HEIGHT / 2,
                anchor: { x: Math.min(pane.width, box.right), y },
            };
        })
        .sort((p, q) => p.anchor.y - q.anchor.y || p.index - q.index);
    const step = GUTTER_LABEL_HEIGHT + GUTTER_LABEL_GAP;

    // Down the gutter: each number below the one before. Then up from the bottom: back inside the pane.
    for (let i = 0; i < labels.length; i++) {
        labels[i].top = Math.max(labels[i].top, 0, i > 0 ? labels[i - 1].top + step : 0);
    }

    for (let i = labels.length - 1; i >= 0; i--) {
        const floor = i < labels.length - 1 ? labels[i + 1].top - step : pane.height - GUTTER_LABEL_HEIGHT;
        labels[i].top = Math.max(0, Math.min(labels[i].top, floor));
    }

    return labels;
}
