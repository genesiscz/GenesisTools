import { detectImageFormat } from "./detect-format";

export interface ImageDimensions {
    width: number;
    height: number;
}

/** Header preflight before native allocation; the decoder still validates the complete image. */
export function checkImageDimensions({ data, maxPixels }: { data: Buffer; maxPixels: number }): ImageDimensions {
    const check = (width: number, height: number): ImageDimensions => {
        if (width < 1 || height < 1 || width * height > maxPixels) {
            throw new Error(`Image attachment exceeds the ${maxPixels} pixel limit or has empty dimensions`);
        }

        return { width, height };
    };
    const format = detectImageFormat(data);

    // PNG IHDR: https://www.w3.org/TR/png-3/#11IHDR
    if (format?.mime === "image/png") {
        if (data.length < 33 || data.toString("ascii", 12, 16) !== "IHDR" || data.readUInt32BE(8) !== 13) {
            throw new Error("Invalid PNG header");
        }

        const dimensions = check(data.readUInt32BE(16), data.readUInt32BE(20));

        for (let offset = 8; offset + 12 <= data.length; ) {
            const length = data.readUInt32BE(offset);
            if (offset + length + 12 > data.length) {
                throw new Error("Truncated PNG chunk");
            }

            if (data.toString("ascii", offset + 4, offset + 8) === "acTL") {
                throw new Error("Use a still PNG image; animated images are not supported");
            }

            offset += length + 12;
        }

        return dimensions;
    }

    // JPEG SOF: libjpeg-turbo/src/jdmarker.c, get_sof.
    if (format?.mime === "image/jpeg") {
        let offset = 2;
        while (offset < data.length) {
            if (data[offset++] !== 0xff) {
                break;
            }

            while (data[offset] === 0xff) {
                offset++;
            }

            const marker = data[offset++];
            if (marker === 0xda || marker === 0xd9) {
                break;
            }

            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
                continue;
            }

            if (offset + 2 > data.length) {
                break;
            }

            const length = data.readUInt16BE(offset);
            if (length < 2 || offset + length > data.length) {
                break;
            }

            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
                return check(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
            }

            offset += length;
        }

        throw new Error("JPEG has no supported dimensions header");
    }

    // WebP RIFF, VP8/VP8L/VP8X: https://developers.google.com/speed/webp/docs/riff_container
    if (format?.mime === "image/webp") {
        const end = data.readUInt32LE(4) + 8;
        if (end > data.length) {
            throw new Error("Truncated WebP container");
        }

        let dimensions: ImageDimensions | undefined;
        for (let offset = 12; offset + 8 <= end; ) {
            const type = data.toString("ascii", offset, offset + 4);
            const size = data.readUInt32LE(offset + 4);
            const start = offset + 8;
            if (start + size > end) {
                throw new Error("Truncated WebP chunk");
            }

            let frame: ImageDimensions | undefined;
            if (type === "VP8X" && size >= 10) {
                if (data[start] & 2) {
                    throw new Error("Use a still WebP image; animated images are not supported");
                }

                frame = check(data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1);
            } else if (type === "VP8L" && size >= 5 && data[start] === 0x2f) {
                const bits = data.readUInt32LE(start + 1);
                frame = check((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
            } else if (
                type === "VP8 " &&
                size >= 10 &&
                data[start + 3] === 0x9d &&
                data[start + 4] === 0x01 &&
                data[start + 5] === 0x2a
            ) {
                frame = check(data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff);
            }

            dimensions ??= frame;
            offset = start + size + (size % 2);
        }

        if (dimensions) {
            return dimensions;
        }

        throw new Error("WebP has no supported dimensions header");
    }

    throw new Error("Unsupported image format");
}
