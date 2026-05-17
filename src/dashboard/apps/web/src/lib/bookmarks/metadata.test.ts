import { describe, expect, it } from "vitest";
import { extractHtmlMetadata } from "./metadata";

describe("extractHtmlMetadata", () => {
    it("extracts <title> tag", () => {
        const html = "<html><head><title>My Page &amp; More</title></head></html>";
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.title).toBe("My Page & More");
    });

    it("prefers og:title over <title>", () => {
        const html = `
      <html><head>
        <title>Fallback Title</title>
        <meta property="og:title" content="OG Title &lt;cool&gt;" />
      </head></html>`;
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.title).toBe("OG Title <cool>");
    });

    it("extracts meta description", () => {
        const html = `<meta name="description" content="A great &quot;article&quot;" />`;
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.description).toBe('A great "article"');
    });

    it("prefers og:description over meta description", () => {
        const html = `
      <meta name="description" content="Plain desc" />
      <meta property="og:description" content="OG desc &#39;quoted&#39;" />`;
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.description).toBe("OG desc 'quoted'");
    });

    it("extracts favicon from <link rel=icon>", () => {
        const html = `<link rel="icon" href="/favicon.ico" />`;
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.faviconUrl).toBe("https://example.com/favicon.ico");
    });

    it("extracts shortcut icon", () => {
        const html = `<link rel="shortcut icon" href="https://cdn.example.com/icon.png" />`;
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.faviconUrl).toBe("https://cdn.example.com/icon.png");
    });

    it("falls back to /favicon.ico when no link tag present", () => {
        const result = extractHtmlMetadata("<html></html>", "https://example.com");
        expect(result.faviconUrl).toBe("https://example.com/favicon.ico");
    });

    it("resolves relative favicon with path", () => {
        const html = `<link rel="icon" href="../img/fav.png" />`;
        const result = extractHtmlMetadata(html, "https://example.com/blog/post");
        expect(result.faviconUrl).toBe("https://example.com/img/fav.png");
    });

    it("decodes numeric HTML entities in title", () => {
        const html = "<title>Test &#8212; dash &#x2019;apostrophe&#x2019;</title>";
        const result = extractHtmlMetadata(html, "https://example.com");
        expect(result.title).toBe("Test — dash ’apostrophe’");
    });

    it("returns empty strings when html has no usable content", () => {
        const result = extractHtmlMetadata("", "https://example.com");
        expect(result.title).toBe("");
        expect(result.description).toBe("");
        expect(result.faviconUrl).toBe("https://example.com/favicon.ico");
    });
});
