import { describe, expect, it } from "bun:test";
import { resolveSearchMode } from "./search-mode";

describe("resolveSearchMode", () => {
    it("passes through valid modes unchanged", () => {
        expect(resolveSearchMode("fulltext")).toBe("fulltext");
        expect(resolveSearchMode("vector")).toBe("vector");
        expect(resolveSearchMode("hybrid")).toBe("hybrid");
    });

    it("maps 'semantic' to 'vector'", () => {
        expect(resolveSearchMode("semantic")).toBe("vector");
    });

    it("returns undefined for unknown modes", () => {
        expect(resolveSearchMode("banana")).toBeUndefined();
    });
});
