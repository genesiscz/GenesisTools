import { describe, expect, it } from "bun:test";
import { parseByteSize, parseCount, resolveMinReal } from "@app/macos/lib/clones/min-real";

describe("parseByteSize", () => {
    it("takes a number with a binary unit, with or without a space, and a fraction with a unit", () => {
        expect(parseByteSize("1024B")).toBe(1024);
        expect(parseByteSize(" 10485760b ")).toBe(10485760);
        expect(parseByteSize("100KB")).toBe(102400);
        expect(parseByteSize("100k")).toBe(102400);
        expect(parseByteSize("10 MB")).toBe(10485760);
        expect(parseByteSize("1.5GB")).toBe(1.5 * 1024 ** 3);
    });

    it("refuses a bare number, so a size never silently means bytes", () => {
        for (const raw of ["1024", "102400", " 10485760 "]) {
            expect(parseByteSize(raw)).toBeNull();
        }
    });

    it("rejects zero, negatives, fractional bytes, partial numbers, unknown units and garbage", () => {
        for (const raw of ["0B", "0KB", "-1", "-1KB", "1.5B", "12abc", "abc", "", "1e6", "0x10", "10 PB"]) {
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

describe("resolveMinReal", () => {
    it("takes --min-real or one unit-named alias, else the fallback", () => {
        expect(resolveMinReal({ minReal: "100KB" }, 7)).toEqual({ bytes: 102400 });
        expect(resolveMinReal({ minRealBytes: "512" }, 7)).toEqual({ bytes: 512 });
        expect(resolveMinReal({ minRealKilobytes: "100" }, 7)).toEqual({ bytes: 102400 });
        expect(resolveMinReal({ minRealMegabytes: "10" }, 7)).toEqual({ bytes: 10 * 1024 ** 2 });
        expect(resolveMinReal({}, 7)).toEqual({ bytes: 7 });
        expect(resolveMinReal({}, undefined)).toEqual({ bytes: undefined });
    });

    it("names the flag on a bad value, and refuses two flags at once", () => {
        expect(resolveMinReal({ minReal: "102400" }, 7)).toEqual({
            error: '--min-real must be a positive size (a number with a unit: 512B, 100KB, 10MB, 1GB), got "102400".',
        });
        expect(resolveMinReal({ minRealKilobytes: "1.5" }, 7)).toEqual({
            error: '--min-real-kilobytes must be a positive size (a whole number), got "1.5".',
        });
        expect(resolveMinReal({ minReal: "1MB", minRealKilobytes: "5" }, 7)).toEqual({
            error: "Pass one of --min-real, --min-real-kilobytes, not several.",
        });
    });
});
