import { describe, expect, it } from "bun:test";
import { splitTextByHighlights } from "./highlight-text-spans";

describe("splitTextByHighlights", () => {
    it("returns plain span when no tokens", () => {
        expect(splitTextByHighlights("hello world", [])).toEqual([{ text: "hello world", highlight: false }]);
    });

    it("marks exact token ranges", () => {
        expect(splitTextByHighlights("foo BAR baz", ["bar"])).toEqual([
            { text: "foo ", highlight: false },
            { text: "BAR", highlight: true },
            { text: " baz", highlight: false },
        ]);
    });
});
