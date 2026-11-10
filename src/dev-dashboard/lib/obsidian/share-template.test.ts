import { describe, expect, test } from "bun:test";
import {
    HEADING_FLASH_DEFAULT_MS,
    HEADING_FLASH_STORAGE_KEY,
    renderSharePage,
} from "@app/dev-dashboard/lib/obsidian/share-template";
import { JSDOM } from "jsdom";

/**
 * The page with the scripts that hold `marker` running against it. Bun cannot run jsdom's own script sandbox, so each
 * script runs with the jsdom window as its scope; jsdom lays nothing out.
 */
function openPage(options: { html: string; marker: string; stored?: Record<string, string> }): JSDOM {
    const { html, marker, stored = {} } = options;
    const page = renderSharePage({
        title: "Pictures",
        rendered: { html, hasMath: false, hasMermaid: false, tags: [] },
        source: "",
        sourcePath: "notes/pictures.md",
    });
    const dom = new JSDOM(page, { url: "http://localhost/share/demo" });

    for (const [key, value] of Object.entries(stored)) {
        dom.window.localStorage.setItem(key, value);
    }

    for (const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        const body = match[1] ?? "";

        if (body.includes(marker)) {
            new Function("window", `with (window) {${body}}`)(dom.window);
        }
    }

    return dom;
}

describe("renderSharePage", () => {
    test("carries the image viewer with its controls, closed, and every inline script of the page parses", () => {
        const page = renderSharePage({
            title: "Pictures",
            rendered: { html: '<p><img src="a.png" alt="A"></p>', hasMath: false, hasMermaid: false, tags: [] },
            source: "![A](a.png)",
            sourcePath: "notes/pictures.md",
        });

        expect(page).toContain('<div class="dd-lightbox" id="dd-lightbox" role="dialog" aria-modal="true"');
        expect(page).toMatch(/id="dd-lightbox"[^>]* hidden>/);
        for (const id of ["prev", "next", "in", "out", "fit", "actual", "original", "close"]) {
            expect(page).toContain(`id="dd-lightbox-${id}"`);
        }

        // The scripts live in a template string: a stray backtick or backslash breaks them without a type error.
        const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
        expect(scripts.some((body) => body.includes('getElementById("dd-lightbox")'))).toBe(true);
        for (const body of scripts) {
            expect(() => new Function(body)).not.toThrow();
        }
    });

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

    test("runs the local Mermaid renderer in a sandbox without network access", () => {
        const page = renderSharePage({
            title: "Diagram",
            rendered: {
                html: '<div class="mermaid">graph TD; A-->B</div>',
                hasMath: false,
                hasMermaid: true,
                tags: [],
            },
            source: "```mermaid\ngraph TD; A-->B\n```",
            mermaidCode: "window.mermaid = {};",
        });

        expect(page).toContain("window.mermaid = {};");
        expect(page).toContain("frame.setAttribute('sandbox', 'allow-scripts')");
        expect(page).toContain("default-src 'none'");
        expect(page).not.toContain("mermaid.esm.min.mjs");
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

    test("a picture alone is a keyboard button that opens the viewer; a picture inside a link keeps the link", () => {
        const dom = openPage({
            html: '<p><img src="a.png" alt="Chart"></p><p><a href="/share/other"><img src="b.png" alt="B"></a></p>',
            marker: 'getElementById("dd-lightbox")',
        });
        const doc = dom.window.document;
        const [alone, linked] = [...doc.querySelectorAll("article img")];

        expect(alone?.getAttribute("tabindex")).toBe("0");
        expect(alone?.getAttribute("role")).toBe("button");
        expect(alone?.getAttribute("aria-label")).toBe("Open image: Chart");
        expect(linked?.hasAttribute("tabindex")).toBe(false);

        alone?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(doc.getElementById("dd-lightbox")?.hidden).toBe(false);
        expect(doc.getElementById("dd-lightbox-caption")?.textContent).toBe("Chart");
        dom.window.close();
    });

    test("page settings set how long a jumped-to heading stays marked, kept in the browser, Off included", () => {
        const fresh = openPage({ html: '<h2 id="a">A</h2>', marker: HEADING_FLASH_STORAGE_KEY });
        const select = fresh.window.document.getElementById("dd-share-heading-flash");
        const root = fresh.window.document.documentElement;

        if (!(select instanceof fresh.window.HTMLSelectElement)) {
            throw new Error("the page settings have no heading highlight select");
        }

        expect(select.value).toBe(String(HEADING_FLASH_DEFAULT_MS));
        expect(root.classList.contains("dd-heading-flash-off")).toBe(false);

        select.value = "3600";
        select.dispatchEvent(new fresh.window.Event("change"));
        expect(root.style.getPropertyValue("--dd-heading-flash")).toBe("3600ms");
        expect(fresh.window.localStorage.getItem(HEADING_FLASH_STORAGE_KEY)).toBe("3600");
        fresh.window.close();

        const off = openPage({
            html: '<h2 id="a">A</h2>',
            marker: HEADING_FLASH_STORAGE_KEY,
            stored: { [HEADING_FLASH_STORAGE_KEY]: "0" },
        });
        const offSelect = off.window.document.getElementById("dd-share-heading-flash");
        expect(off.window.document.documentElement.classList.contains("dd-heading-flash-off")).toBe(true);
        expect(offSelect instanceof off.window.HTMLSelectElement && offSelect.value).toBe("0");
        off.window.close();
    });
});
