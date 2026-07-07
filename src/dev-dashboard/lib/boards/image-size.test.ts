import { describe, expect, it } from "bun:test";
import { readImageDims } from "./image-size";

function u16be(n: number): number[] {
    return [(n >> 8) & 0xff, n & 0xff];
}
function u32be(n: number): number[] {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u16le(n: number): number[] {
    return [n & 0xff, (n >> 8) & 0xff];
}
function u24le(n: number): number[] {
    return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
}

function buildPng(width: number, height: number): Uint8Array {
    return new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // signature
        0x00,
        0x00,
        0x00,
        0x0d, // IHDR chunk length
        0x49,
        0x48,
        0x44,
        0x52, // "IHDR"
        ...u32be(width),
        ...u32be(height),
        0x08,
        0x06,
        0x00,
        0x00,
        0x00, // bit depth/color type/compression/filter/interlace
        0x00,
        0x00,
        0x00,
        0x00, // CRC placeholder
    ]);
}

function buildGif(width: number, height: number): Uint8Array {
    return new Uint8Array([
        0x47,
        0x49,
        0x46,
        0x38,
        0x39,
        0x61, // "GIF89a"
        ...u16le(width),
        ...u16le(height),
        0x00,
        0x00,
        0x00,
    ]);
}

function buildJpeg(width: number, height: number): Uint8Array {
    const app0Payload = new Array(14).fill(0);
    const sofPayload = [
        0x08,
        ...u16be(height),
        ...u16be(width),
        0x03,
        0x01,
        0x11,
        0x00,
        0x02,
        0x11,
        0x01,
        0x03,
        0x11,
        0x01,
    ];
    return new Uint8Array([
        0xff,
        0xd8, // SOI
        0xff,
        0xe0, // APP0
        ...u16be(2 + app0Payload.length),
        ...app0Payload,
        0xff,
        0xc0, // SOF0
        ...u16be(2 + sofPayload.length),
        ...sofPayload,
        0xff,
        0xd9, // EOI (unreached)
    ]);
}

function buildWebpVp8x(width: number, height: number): Uint8Array {
    const vp8xPayload = [0x00, 0x00, 0x00, 0x00, ...u24le(width - 1), ...u24le(height - 1)];
    const chunkLen = vp8xPayload.length;
    const body = [0x56, 0x50, 0x38, 0x58, ...u32be(chunkLen).reverse(), ...vp8xPayload]; // "VP8X" + LE length + payload
    return new Uint8Array([
        0x52,
        0x49,
        0x46,
        0x46, // "RIFF"
        ...u32be(4 + body.length).reverse(), // file size (LE), unused by parser
        0x57,
        0x45,
        0x42,
        0x50, // "WEBP"
        ...body,
        0x00, // padding so length > 30 (parser's minimum-length guard)
    ]);
}

describe("readImageDims", () => {
    it("parses PNG dimensions from the IHDR chunk", () => {
        expect(readImageDims(buildPng(320, 200))).toEqual({ width: 320, height: 200 });
    });

    it("parses GIF dimensions", () => {
        expect(readImageDims(buildGif(640, 480))).toEqual({ width: 640, height: 480 });
    });

    it("parses JPEG dimensions from the SOF0 marker", () => {
        expect(readImageDims(buildJpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
    });

    it("parses WebP (VP8X) dimensions", () => {
        expect(readImageDims(buildWebpVp8x(400, 300))).toEqual({ width: 400, height: 300 });
    });

    it("returns null for garbage bytes", () => {
        expect(readImageDims(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
        expect(readImageDims(new Uint8Array(0))).toBeNull();
    });
});
