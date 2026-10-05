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

    test("a source file downloads as plain text under its own name, a note as markdown", () => {
        const options = {
            title: "Report",
            rendered: { html: "<p>x</p>", hasMath: false, hasMermaid: false, tags: [] },
            source: "export const x = 1;",
        };
        const code = renderSharePage({ ...options, sourcePath: "src/Report.ts" });
        const note = renderSharePage({ ...options, sourcePath: "notes/Report.md" });

        expect(code).toContain('a.download = "Report.ts"');
        expect(code).toContain('type: "text/plain;charset=utf-8"');
        expect(code).not.toContain("text/markdown");
        expect(note).toContain('a.download = "Report.md"');
        expect(note).toContain('type: "text/markdown;charset=utf-8"');
    });

    test("a source file page names the source in its toolbar and toggle, a note names markdown", () => {
        const options = {
            title: "Report",
            rendered: { html: "<p>x</p>", hasMath: false, hasMermaid: false, tags: [] },
            source: "export const x = 1;",
        };
        const code = renderSharePage({ ...options, sourcePath: "src/Report.ts" });
        const note = renderSharePage({ ...options, sourcePath: "notes/Report.md" });

        expect(code).toContain('aria-label="Show raw source"');
        expect(code).toContain('aria-label="Download source file"');
        expect(code).toContain('"Show highlighted source"');
        expect(code).not.toContain("raw markdown");
        expect(code).not.toContain("rendered note");
        expect(note).toContain('aria-label="Show raw markdown source"');
        expect(note).toContain('aria-label="Download raw markdown"');
        expect(note).toContain('"Show rendered note"');
    });
});
