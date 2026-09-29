import { describe, expect, test } from "bun:test";
import { detectImageFormat } from "./detect-format";

function bytes(...values: number[]): Buffer {
    return Buffer.from(values);
}

describe("detectImageFormat", () => {
    test("PNG signature", () => {
        expect(detectImageFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0))).toEqual({
            mime: "image/png",
            ext: "png",
        });
    });

    test("JPEG signature", () => {
        expect(detectImageFormat(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0))).toEqual({
            mime: "image/jpeg",
            ext: "jpg",
        });
    });

    test("GIF signature", () => {
        expect(detectImageFormat(Buffer.from(`GIF89a${"\0".repeat(6)}`, "ascii"))).toEqual({
            mime: "image/gif",
            ext: "gif",
        });
    });

    test("WEBP signature (RIFF....WEBP)", () => {
        expect(detectImageFormat(Buffer.from("RIFF\0\0\0\0WEBP", "ascii"))).toEqual({
            mime: "image/webp",
            ext: "webp",
        });
    });

    test("BMP signature", () => {
        expect(detectImageFormat(Buffer.from(`BM${"\0".repeat(10)}`, "ascii"))).toEqual({
            mime: "image/bmp",
            ext: "bmp",
        });
    });

    test("an unknown signature is no image, never a guessed PNG", () => {
        expect(detectImageFormat(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))).toBeNull();
        expect(detectImageFormat(Buffer.from("#!/bin/sh\necho hi\n", "ascii"))).toBeNull();
    });

    test("a buffer too short to carry any signature is no image either", () => {
        expect(detectImageFormat(bytes(1, 2, 3))).toBeNull();
    });
});
