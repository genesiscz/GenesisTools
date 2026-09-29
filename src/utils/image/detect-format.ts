export interface DetectedImageFormat {
    mime: string;
    /** Extension without leading dot, e.g. "png". */
    ext: string;
}

/**
 * Detect an image container from its leading magic bytes, never from a filename extension: a
 * caller handing this a user-picked path cannot be trusted to have named it honestly. Falls
 * back to `image/png` when the signature is unknown, matching `sanitizeImages`'
 * (`src/question/lib/pending/form.ts`) own default.
 */
export function detectImageFormat(buf: Buffer): DetectedImageFormat {
    if (buf.length < 12) {
        return { mime: "image/png", ext: "png" };
    }

    // PNG: 0x89 "PNG\r\n\x1a\n"
    if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
        return { mime: "image/png", ext: "png" };
    }

    // JPEG: 0xFF 0xD8 0xFF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { mime: "image/jpeg", ext: "jpg" };
    }

    // GIF: "GIF87a" or "GIF89a"
    if (buf.toString("ascii", 0, 3) === "GIF") {
        return { mime: "image/gif", ext: "gif" };
    }

    // WEBP: "RIFF....WEBP"
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
        return { mime: "image/webp", ext: "webp" };
    }

    // BMP: "BM"
    if (buf.toString("ascii", 0, 2) === "BM") {
        return { mime: "image/bmp", ext: "bmp" };
    }

    return { mime: "image/png", ext: "png" };
}
