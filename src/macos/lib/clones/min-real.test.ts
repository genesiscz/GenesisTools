import { describe, expect, it } from "bun:test";
import { parseByteSize, parseCount } from "@app/macos/lib/clones/min-real";

describe("parseByteSize", () => {
    it("accepts a positive whole number of bytes", () => {
        expect(parseByteSize("1024")).toBe(1024);
        expect(parseByteSize(" 10485760 ")).toBe(10485760);
    });

    it("accepts a binary unit, with or without a space, and a fraction with a unit", () => {
        expect(parseByteSize("100KB")).toBe(102400);
        expect(parseByteSize("100k")).toBe(102400);
        expect(parseByteSize("10 MB")).toBe(10485760);
        expect(parseByteSize("1.5GB")).toBe(1.5 * 1024 ** 3);
        expect(parseByteSize("512b")).toBe(512);
    });

    it("rejects zero, negatives, unitless fractions, partial numbers, unknown units and garbage", () => {
        for (const raw of ["0", "0KB", "-1", "-1KB", "1.5", "12abc", "abc", "", "1e6", "0x10", "10 PB"]) {
            expect(parseByteSize(raw)).toBeNull();
        }
    });
});

describe("parseCount", () => {
    it("takes a positive whole number and refuses a unit", () => {
        expect(parseCount("500")).toBe(500);
        for (const raw of ["0", "-3", "1.5", "5KB", "lots"]) {
            expect(parseCount(raw)).toBeNull();
        }
    });
});
