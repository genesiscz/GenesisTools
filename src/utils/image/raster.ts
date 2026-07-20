import { createCanvas, ImageData, loadImage } from "@napi-rs/canvas";

export interface DecodedRgba {
    width: number;
    height: number;
    /** RGBA bytes, row-major — pixelmatch-ready. */
    data: Uint8ClampedArray;
}

export async function decodeImageRgba(input: string | Buffer): Promise<DecodedRgba> {
    const image = await loadImage(input);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
}

/** Decode and force into the given dimensions (high-quality resample). */
export async function decodeImageRgbaScaled(
    input: string | Buffer,
    width: number,
    height: number
): Promise<DecodedRgba> {
    const image = await loadImage(input);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);
    return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

/** Encode raw RGBA bytes back into a PNG buffer. */
export function encodeRgbaToPng(rgba: Uint8ClampedArray, width: number, height: number): Buffer {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas.toBuffer("image/png");
}
