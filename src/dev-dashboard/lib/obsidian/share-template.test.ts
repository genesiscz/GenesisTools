import { describe, expect, test } from "bun:test";
import { renderSharePage } from "@app/dev-dashboard/lib/obsidian/share-template";

describe("renderSharePage", () => {
    test("includes raw source toggle and embedded markdown", () => {
        const page = renderSharePage({
            title: "Test Note",
            rendered: { html: "<p>Hello</p>", hasMath: false, hasMermaid: false, tags: [] },
            source: "# Hello\n\nWorld",
            sourcePath: "notes/test.md",
        });

        expect(page).toContain('id="dd-share-view-btn"');
        expect(page).toContain('id="dd-share-source-panel"');
        expect(page).toContain('id="dd-share-source-data"');
        expect(page).toContain("# Hello\\n\\nWorld");
        expect(page).toContain("Show raw markdown source");
    });

    test("SRI-pins the Mermaid ESM entry when the note uses mermaid", () => {
        const page = renderSharePage({
            title: "Diagram",
            rendered: {
                html: '<div class="mermaid">graph TD; A-->B</div>',
                hasMath: false,
                hasMermaid: true,
                tags: [],
            },
            source: "```mermaid\ngraph TD; A-->B\n```",
        });

        expect(page).toContain('rel="modulepreload"');
        expect(page).toContain("mermaid@11.15.0/dist/mermaid.esm.min.mjs");
        expect(page).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
        expect(page).toContain('crossorigin="anonymous"');
    });

    test("does not emit the Mermaid preload when the note has no mermaid", () => {
        const page = renderSharePage({
            title: "Plain",
            rendered: { html: "<p>plain</p>", hasMath: false, hasMermaid: false, tags: [] },
            source: "plain",
        });

        expect(page).not.toContain("mermaid.esm.min.mjs");
    });
});
