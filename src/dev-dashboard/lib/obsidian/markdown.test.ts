import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";

const noop = { resolveWikilink: () => null };

describe("renderMarkdown", () => {
    test("renders basic markdown", () => {
        const { html } = renderMarkdown("# Hello\n\nWorld", noop);

        expect(html).toContain("<h1");
        expect(html).toContain("Hello");
    });

    test("wikilink to unpublished note renders plain styled text", () => {
        const { html } = renderMarkdown("see [[Other Note]] here", noop);

        expect(html).toContain("Other Note");
        expect(html).not.toContain("href=");
    });

    test("wikilink to published note links to share slug", () => {
        const { html } = renderMarkdown("see [[Other Note]] here", {
            resolveWikilink: (name) => (name === "Other Note" ? "abc123" : null),
        });

        expect(html).toContain('href="/share/abc123"');
        expect(html).toContain(">Other Note</a>");
    });

    test("wikilink aliases use alias text", () => {
        const { html } = renderMarkdown("see [[Other Note|this note]] here", {
            resolveWikilink: (name) => (name === "Other Note" ? "abc123" : null),
        });

        expect(html).toContain('href="/share/abc123"');
        expect(html).toContain(">this note</a>");
    });

    test("renders leading tags as metadata pills instead of body text", () => {
        const { html } = renderMarkdown("tags: [braindump, research]\n# Title", noop);

        expect(html).toContain('class="dd-md-meta"');
        expect(html).toContain(">#braindump</span>");
        expect(html).not.toContain("<p>tags:");
    });

    test("strips yaml frontmatter from the article body", () => {
        const { html } = renderMarkdown("---\ntags:\n  - cmux\n---\n# Title", noop);

        expect(html).toContain('class="dd-md-meta"');
        expect(html).not.toContain("<hr>");
        expect(html).not.toContain("tags:");
    });

    test("renders gfm tables and task lists", () => {
        const { html } = renderMarkdown("- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |", noop);

        expect(html).toContain('type="checkbox"');
        expect(html).toContain("<table>");
    });

    test("does NOT process wikilinks inside inline code spans", () => {
        const { html } = renderMarkdown("use `[[NotALink]]` literally", noop);

        expect(html).toContain("<code>[[NotALink]]</code>");
        expect(html).not.toContain("dd-wikilink");
    });

    test("does NOT process wikilinks inside fenced code blocks", () => {
        const md = "```\n[[ČEZ]] should stay literal\n```";
        const { html } = renderMarkdown(md, noop);

        expect(html).toContain("[[ČEZ]]");
        expect(html).not.toContain("dd-wikilink");
    });

    test("renders GFM-style alert callouts", () => {
        const md = "> [!warning]\n> something to watch";
        const { html } = renderMarkdown(md, noop);

        expect(html.toLowerCase()).toContain("markdown-alert");
        expect(html.toLowerCase()).toContain("warning");
    });

    test("highlights fenced code blocks with hljs classes", () => {
        const md = "```ts\nconst x: number = 1;\n```";
        const { html } = renderMarkdown(md, noop);

        expect(html).toContain("hljs language-ts");
        expect(html).toContain("hljs-keyword");
    });

    test("passes mermaid blocks through and sets hasMermaid", () => {
        const md = "```mermaid\ngraph TD; A-->B;\n```";
        const result = renderMarkdown(md, noop);

        expect(result.html).toContain('<div class="mermaid">');
        expect(result.hasMermaid).toBe(true);
    });

    test("renders inline math via katex and sets hasMath", () => {
        const result = renderMarkdown("Euler $e^{i\\pi} + 1 = 0$ wow", noop);

        expect(result.hasMath).toBe(true);
        expect(result.html).toContain("katex");
    });

    test("styles bare body tags as pills", () => {
        const { html } = renderMarkdown("plain text #braindump and more text", noop);

        expect(html).toContain("dd-md-inline-tag");
        expect(html).toContain(">#braindump</span>");
    });

    test("does NOT mistake H1 hash for an inline tag", () => {
        const { html } = renderMarkdown("# Heading\n\nplain", noop);

        expect(html).toContain("<h1");
        expect(html).not.toContain('dd-md-inline-tag">#Heading');
    });

    test("renders ![[file]] embeds as a stub", () => {
        const { html } = renderMarkdown("![[image.png]]", noop);

        expect(html).toContain("dd-md-embed-stub");
        expect(html).toContain("image.png");
    });
});
