import { describe, expect, it } from "bun:test";
import { fuzzySearchByHaystack, fuzzySearchWithContext } from "./fuzzy-search";

describe("fuzzySearchByHaystack", () => {
    it("returns all items when query is empty", () => {
        const items = ["alpha", "beta"];
        const result = fuzzySearchByHaystack(items, "", (s) => s);

        expect(result.items).toEqual(items);
        expect(result.tokens).toEqual([]);
    });

    it("ranks items by token coverage", () => {
        const items = ["unrelated", "metro bundler", "metro"];
        const result = fuzzySearchByHaystack(items, "metro", (s) => s);

        expect(result.items).toEqual(["metro bundler", "metro"]);
        expect(result.tokens).toEqual(["metro"]);
    });
});

describe("fuzzySearchWithContext", () => {
    const lines = ["line-0", "line-1", "line-2 MATCH", "line-3", "line-4", "line-5 OTHER"];

    it("returns all lines when query is empty", () => {
        const result = fuzzySearchWithContext({
            items: lines,
            query: "",
            haystack: (line) => line,
        });

        expect(result.hits).toHaveLength(lines.length);
        expect(result.matchCount).toBe(0);
    });

    it("includes context lines around matches", () => {
        const result = fuzzySearchWithContext({
            items: lines,
            query: "MATCH",
            haystack: (line) => line,
            contextLines: 1,
        });

        expect(result.matchCount).toBe(1);
        expect(result.hits.map((h) => h.item)).toEqual(["line-1", "line-2 MATCH", "line-3"]);
        expect(result.hits.find((h) => h.item === "line-2 MATCH")?.isMatch).toBe(true);
        expect(result.hits.find((h) => h.item === "line-1")?.isMatch).toBe(false);
    });
});
