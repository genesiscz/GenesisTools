import { describe, expect, it } from "bun:test";
import { fuzzyResolveSession } from "./fuzzy-resolver";

describe("fuzzyResolveSession", () => {
    it("exact match wins", () => {
        expect(fuzzyResolveSession("metro", ["metro-react", "metro"])).toBe("metro");
    });

    it("fuzzy match returns best candidate", () => {
        expect(fuzzyResolveSession("metro", ["metro-react", "api"])).toBe("metro-react");
    });

    it("throws when no match", () => {
        expect(() => fuzzyResolveSession("zzz", ["metro"])).toThrow(/not found/i);
    });
});
