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
});
