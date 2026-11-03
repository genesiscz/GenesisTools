import { readFile } from "node:fs/promises";
import { detectImageFormat } from "@genesiscz/utils/image/detect-format";

/** An image file path, its bytes, or bytes with a known type. */
export type ShowInput = string | Uint8Array | { bytes: Uint8Array | string; mimeType?: string } | { path: string };

export interface ShowableImage {
    bytes: Uint8Array;
    mimeType: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !(value instanceof Uint8Array);
}

/** The bytes and MIME type of what `show()` was given; refuses anything that is not a PNG, JPEG, GIF or WebP. */
export async function readShowable(input: ShowInput): Promise<ShowableImage> {
    let bytes: Uint8Array;
    let mimeType: string | undefined;

    if (typeof input === "string") {
        bytes = await readFile(input);
    } else if (input instanceof Uint8Array) {
        bytes = input;
    } else if (isRecord(input) && "path" in input && typeof input.path === "string") {
        bytes = await readFile(input.path);
    } else if (isRecord(input) && "bytes" in input) {
        bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes, "base64") : input.bytes;
        mimeType = input.mimeType;
    } else {
        throw new Error("show() takes an image path, a Buffer or Uint8Array, { path } or { bytes, mimeType }");
    }

    const detected = detectImageFormat(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const type = mimeType ?? detected?.mime;

    if (!type?.startsWith("image/")) {
        throw new Error("show() got bytes that are not a PNG, JPEG, GIF or WebP image");
    }

    return { bytes, mimeType: type };
}
