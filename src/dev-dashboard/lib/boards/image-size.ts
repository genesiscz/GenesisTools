export interface ImageDims {
    width: number;
    height: number;
}

function u32be(b: Uint8Array, o: number): number {
    return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
}
function u16be(b: Uint8Array, o: number): number {
    return (b[o] << 8) | b[o + 1];
}
function u16le(b: Uint8Array, o: number): number {
    return b[o] | (b[o + 1] << 8);
}
function u24le(b: Uint8Array, o: number): number {
    return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

/** Best-effort dimensions for PNG/JPEG/WebP/GIF; null when unknown. */
export function readImageDims(b: Uint8Array): ImageDims | null {
    // PNG: 8-byte signature, IHDR width/height at offsets 16/20
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        return { width: u32be(b, 16) >>> 0, height: u32be(b, 20) >>> 0 };
    }
    // GIF87a/89a: LE uint16 at 6/8
    if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
        return { width: u16le(b, 6), height: u16le(b, 8) };
    }
    // JPEG: walk markers to SOFn
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
        let o = 2;
        while (o + 9 < b.length) {
            if (b[o] !== 0xff) {
                o += 1;
                continue;
            }
            const marker = b[o + 1];
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
            }
            o += 2 + u16be(b, o + 2);
        }
        return null;
    }
    // WebP: RIFF....WEBP + VP8X | VP8L | VP8(lossy)
    if (
        b.length > 30 &&
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46 &&
        b[8] === 0x57 &&
        b[9] === 0x45 &&
        b[10] === 0x42 &&
        b[11] === 0x50
    ) {
        const four = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (four === "VP8X") {
            return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
        }
        if (four === "VP8L" && b[20] === 0x2f) {
            const width = 1 + (b[21] | ((b[22] & 0x3f) << 8));
            const height = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10));
            return { width, height };
        }
        if (four === "VP8 ") {
            return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
        }
    }
    return null;
}
