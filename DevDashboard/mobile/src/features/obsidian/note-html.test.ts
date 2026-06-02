import { describe, expect, it } from "bun:test";
import { buildNoteDocument, parseNoteMessage, shareUrl } from "@/features/obsidian/note-html";

describe("buildNoteDocument", () => {
    it("embeds the server html fragment inside a full document with theme + bridge", () => {
        const doc = buildNoteDocument('<h1>Hi</h1><a data-obsidian-note="ČEZ/x.md">x</a>');
        expect(doc).toContain("<!doctype html>");
        expect(doc).toContain('<meta name="viewport"');
        expect(doc).toContain("<h1>Hi</h1>");
        // theme tokens present (we inject CSS, not RN styles, for the WebView body):
        expect(doc).toContain("--dd-bg");
        // emerald accent (NOT the stale blue plan value):
        expect(doc).toContain("#34d399");
        // bridge present:
        expect(doc).toContain("ReactNativeWebView.postMessage");
        expect(doc).toContain("data-obsidian-note");
    });

    it("always loads the highlight.js theme CSS (code blocks are common)", () => {
        const doc = buildNoteDocument("<pre><code>x</code></pre>");
        expect(doc).toContain("highlightjs/cdn-release");
        expect(doc).toContain("atom-one-dark");
    });

    it("loads KaTeX CSS ONLY when math is present (detected from the html)", () => {
        const withMath = buildNoteDocument('<span class="katex">x</span>');
        const without = buildNoteDocument("<p>plain</p>");
        expect(withMath).toContain("katex.min.css");
        expect(without).not.toContain("katex.min.css");
    });

    it("imports + inits mermaid ONLY when a mermaid block is present", () => {
        const withMermaid = buildNoteDocument('<div class="mermaid">graph TD; A--&gt;B;</div>');
        const without = buildNoteDocument("<p>plain</p>");
        expect(withMermaid).toContain("mermaid.esm.min.mjs");
        expect(withMermaid).toContain("mermaid.initialize");
        expect(withMermaid).toContain("startOnLoad: true");
        expect(without).not.toContain("mermaid.esm.min.mjs");
    });

    it("keeps the click bridge in <head> so body content cannot terminate it", () => {
        const doc = buildNoteDocument("<p>before</script><script>alert(1)</script>after</p>");
        const headEnd = doc.indexOf("</head>");
        const bridge = doc.indexOf("ReactNativeWebView.postMessage");
        expect(bridge).toBeGreaterThan(-1);
        expect(bridge).toBeLessThan(headEnd);
    });
});

describe("parseNoteMessage", () => {
    it("parses a wikilink-tap message", () => {
        const msg = parseNoteMessage(JSON.stringify({ type: "note", path: "ČEZ/x.md" }));
        expect(msg).toEqual({ type: "note", path: "ČEZ/x.md" });
    });

    it("parses an external-link message", () => {
        const msg = parseNoteMessage(JSON.stringify({ type: "external", url: "https://x.dev" }));
        expect(msg).toEqual({ type: "external", url: "https://x.dev" });
    });

    it("returns null for malformed or unknown messages", () => {
        expect(parseNoteMessage("not json")).toBeNull();
        expect(parseNoteMessage(JSON.stringify({ type: "nope" }))).toBeNull();
        expect(parseNoteMessage(JSON.stringify({ type: "note" }))).toBeNull();
    });
});

describe("shareUrl", () => {
    it("builds <baseUrl>/share/<slug>, trimming a trailing slash", () => {
        expect(shareUrl("http://mac.local:3042/", "abc123")).toBe("http://mac.local:3042/share/abc123");
        expect(shareUrl("http://mac.local:3042", "abc123")).toBe("http://mac.local:3042/share/abc123");
    });

    it("returns null for a missing slug", () => {
        expect(shareUrl("http://h", null)).toBeNull();
    });
});
