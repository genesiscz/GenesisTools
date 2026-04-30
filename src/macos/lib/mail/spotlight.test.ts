import { describe, expect, it } from "bun:test";
import { extractRowidFromEmlxPath, sanitizeSpotlightQuery } from "./spotlight";

describe("extractRowidFromEmlxPath", () => {
    it("parses rowid from a full canonical Mail path", () => {
        expect(extractRowidFromEmlxPath("/Users/x/Library/Mail/V10/IMAP-foo/INBOX.mbox/Messages/12345.emlx")).toBe(
            12345
        );
    });

    it("parses rowid from a partial.emlx path", () => {
        expect(extractRowidFromEmlxPath("/Users/x/Library/Mail/V10/INBOX.mbox/Messages/9876.partial.emlx")).toBe(9876);
    });

    it("returns null for non-numeric basename", () => {
        expect(extractRowidFromEmlxPath("/foo/bar/notanumber.emlx")).toBeNull();
    });

    it("returns null for non-emlx extension", () => {
        expect(extractRowidFromEmlxPath("/foo/bar/123.txt")).toBeNull();
    });

    it("returns null for empty path", () => {
        expect(extractRowidFromEmlxPath("")).toBeNull();
    });

    it("returns null for paths with non-integer prefix", () => {
        expect(extractRowidFromEmlxPath("/foo/bar/12a3.emlx")).toBeNull();
    });

    it("handles a bare basename without leading dirs", () => {
        expect(extractRowidFromEmlxPath("42.emlx")).toBe(42);
    });
});

describe("sanitizeSpotlightQuery", () => {
    it("strips quotes and shell metacharacters", () => {
        expect(sanitizeSpotlightQuery('foo "bar" baz')).toBe("foo bar baz");
        expect(sanitizeSpotlightQuery("foo;DROP TABLE")).toBe("foo DROP TABLE");
        expect(sanitizeSpotlightQuery("foo $(rm -rf)")).toBe("foo rm -rf");
        expect(sanitizeSpotlightQuery("foo\\bar")).toBe("foo bar");
    });

    it("strips Spotlight metacharacters", () => {
        expect(sanitizeSpotlightQuery("foo*bar")).toBe("foo bar");
        expect(sanitizeSpotlightQuery("foo (bar) baz")).toBe("foo bar baz");
        expect(sanitizeSpotlightQuery("foo[bar]")).toBe("foo bar");
        expect(sanitizeSpotlightQuery("foo{bar}")).toBe("foo bar");
        expect(sanitizeSpotlightQuery("a < b > c")).toBe("a b c");
        expect(sanitizeSpotlightQuery("a == b")).toBe("a b");
        expect(sanitizeSpotlightQuery("a && b")).toBe("a b");
        expect(sanitizeSpotlightQuery("a || b")).toBe("a b");
        expect(sanitizeSpotlightQuery("a, b")).toBe("a b");
        expect(sanitizeSpotlightQuery("a!b")).toBe("a b");
        expect(sanitizeSpotlightQuery("a?b")).toBe("a b");
    });

    it("preserves common punctuation", () => {
        expect(sanitizeSpotlightQuery("john's report")).toBe("john's report");
        expect(sanitizeSpotlightQuery("user@example.com")).toBe("user@example.com");
        expect(sanitizeSpotlightQuery("foo-bar")).toBe("foo-bar");
        expect(sanitizeSpotlightQuery("file.name")).toBe("file.name");
        expect(sanitizeSpotlightQuery("snake_case")).toBe("snake_case");
    });

    it("preserves Unicode letters/digits including diacritics", () => {
        expect(sanitizeSpotlightQuery("nahlášení")).toBe("nahlášení");
        expect(sanitizeSpotlightQuery("café 2026")).toBe("café 2026");
        expect(sanitizeSpotlightQuery("日本語 testing")).toBe("日本語 testing");
        expect(sanitizeSpotlightQuery("Příklad žluťoučký")).toBe("Příklad žluťoučký");
    });

    it("collapses internal whitespace", () => {
        expect(sanitizeSpotlightQuery("  foo   bar  ")).toBe("foo bar");
        expect(sanitizeSpotlightQuery("foo\t\tbar")).toBe("foo bar");
        expect(sanitizeSpotlightQuery("foo\n\nbar")).toBe("foo bar");
    });

    it("returns empty string for all-metacharacter input", () => {
        expect(sanitizeSpotlightQuery('"\\$()[]')).toBe("");
        expect(sanitizeSpotlightQuery("***")).toBe("");
        expect(sanitizeSpotlightQuery("&&&")).toBe("");
    });

    it("returns empty string for empty / whitespace-only input", () => {
        expect(sanitizeSpotlightQuery("")).toBe("");
        expect(sanitizeSpotlightQuery("   ")).toBe("");
        expect(sanitizeSpotlightQuery("\t\n")).toBe("");
    });

    it("normalizes Unicode (NFC) so combining marks fold correctly", () => {
        // "é" can be U+00E9 (precomposed) or "e" + U+0301 (combining acute)
        const precomposed = "café";
        const decomposed = "café";
        const a = sanitizeSpotlightQuery(precomposed);
        const b = sanitizeSpotlightQuery(decomposed);
        expect(a).toBe(b);
        expect(a).toBe("café");
    });
});
