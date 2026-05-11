import { describe, expect, it } from "bun:test";
import { grepLog, stripJenkinsHtml } from "./log";

describe("stripJenkinsHtml", () => {
    it("removes timestamp spans (b + hidden ISO)", () => {
        const input =
            '<span class="timestamp"><b>19:33:34</b> </span><span style="display: none">[2026-05-11T17:33:34.157Z]</span> + foo@1.0.0';
        expect(stripJenkinsHtml(input)).toBe(" + foo@1.0.0");
    });

    it("preserves text without spans", () => {
        expect(stripJenkinsHtml("plain text")).toBe("plain text");
    });

    it("handles multiline logs", () => {
        const input = `<span class="timestamp"><b>19:33:34</b> </span><span style="display: none">[2026-05-11T17:33:34.157Z]</span>a
<span class="timestamp"><b>19:33:35</b> </span><span style="display: none">[2026-05-11T17:33:35.000Z]</span>b`;
        expect(stripJenkinsHtml(input)).toBe("a\nb");
    });

    it("strips any leftover span tags after the main pattern", () => {
        const input = "<span>foo</span> bar";
        expect(stripJenkinsHtml(input)).toBe("foo bar");
    });
});

describe("grepLog", () => {
    it("returns matches formatted as 'L<n>: <text>'", () => {
        const content = "alpha\nbravo MATCH\ncharlie\ndelta MATCH";
        expect(grepLog(content, "MATCH")).toEqual(["L2: bravo MATCH", "L4: delta MATCH"]);
    });

    it("trims trailing \\r from matched lines (Jenkins CRLF)", () => {
        const content = "alpha MATCH\r\nbravo MATCH\r";
        expect(grepLog(content, "MATCH")).toEqual(["L1: alpha MATCH", "L2: bravo MATCH"]);
    });

    it("caps at 200 matches", () => {
        const content = Array.from({ length: 500 }, (_, i) => `hit ${i}`).join("\n");
        expect(grepLog(content, "hit").length).toBe(200);
    });

    it("resets lastIndex so /g patterns don't skip", () => {
        const content = "alpha bravo\ncharlie bravo\ndelta bravo";
        const matches = grepLog(content, "(?:^|\\W)bravo(?:\\W|$)");
        expect(matches.length).toBe(3);
    });

    it("returns empty array when no matches", () => {
        expect(grepLog("alpha\nbravo", "nothere")).toEqual([]);
    });
});
