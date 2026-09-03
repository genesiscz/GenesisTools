import { describe, expect, it } from "bun:test";
import { parseMinReal } from "@app/macos/lib/clones/min-real";

describe("parseMinReal", () => {
    it("accepts a positive whole number of bytes", () => {
        expect(parseMinReal("1024")).toBe(1024);
        expect(parseMinReal(" 10485760 ")).toBe(10485760);
    });

    it("rejects zero, negatives, fractions, partial numbers and garbage", () => {
        for (const raw of ["0", "-1", "1.5", "12abc", "abc", "", "1e6", "0x10"]) {
            expect(parseMinReal(raw)).toBeNull();
        }
    });
});
