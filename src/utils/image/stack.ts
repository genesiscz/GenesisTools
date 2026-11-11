/**
 * Finishing an annotated page shot: the overlay's pixels onto the raw image, parts stacked into one image, PNG or
 * WebP out. In-process with @napi-rs/canvas, so a shot needs no ImageMagick and no cwebp.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { AnnotationRect } from "./annotation-plan";

/**
 * The final annotated image: the raw screenshot everywhere, and the annotated screenshot only inside `painted` (the
 * frames, chips and leader lines). So the pair differs only under the overlay, also when the page changed a pixel
 * between the two screenshots. That holds for this PNG; encodeImage's WebP is lossy and re-encodes every pixel.
 */
export async function composeOverlay(input: {
    raw: Buffer;
    annotated: Buffer;
    painted: readonly AnnotationRect[];
}): Promise<Buffer> {
    const [raw, annotated] = await Promise.all([loadImage(input.raw), loadImage(input.annotated)]);
    if (raw.width !== annotated.width || raw.height !== annotated.height) {
        throw new Error(
            `the raw (${raw.width}x${raw.height}) and annotated (${annotated.width}x${annotated.height}) shots differ in size`
        );
    }

    const canvas = createCanvas(raw.width, raw.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(raw, 0, 0);
    for (const area of input.painted) {
        ctx.drawImage(annotated, area.x, area.y, area.w, area.h, area.x, area.y, area.w, area.h);
    }

    return canvas.toBuffer("image/png");
}

/** Images top to bottom, left aligned, no gap and no scaling; a narrower one is padded with `background`. */
export async function stackImages(images: readonly Buffer[], background = "#ffffff"): Promise<Buffer> {
    if (images.length === 1) {
        return images[0];
    }

    const loaded = await Promise.all(images.map((image) => loadImage(image)));
    const width = Math.max(...loaded.map((image) => image.width));
    const height = loaded.reduce((sum, image) => sum + image.height, 0);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    let y = 0;
    for (const image of loaded) {
        ctx.drawImage(image, 0, y);
        y += image.height;
    }

    return canvas.toBuffer("image/png");
}

export interface EncodeOptions {
    /** WebP quality, 0 to 100 (default 85). */
    quality?: number;
    /** A wider image is scaled down to this width, keeping its aspect ratio; 0 or absent keeps the full width. */
    maxWidth?: number;
}

/** PNG as it is, or WebP at `quality`, scaled down to `maxWidth` when it is wider (ImageMagick's `-resize "Nx>"`). */
export async function encodeImage(png: Buffer, format: "png" | "webp", options: EncodeOptions = {}): Promise<Buffer> {
    if (format === "png") {
        return png;
    }

    const image = await loadImage(png);
    const maxWidth = options.maxWidth ?? 0;
    const scale = maxWidth > 0 && image.width > maxWidth ? maxWidth / image.width : 1;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);
    return canvas.encode("webp", options.quality ?? 85);
}
