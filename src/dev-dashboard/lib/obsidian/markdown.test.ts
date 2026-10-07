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

    test("wikilink to vault note links to obsidian route", () => {
        const { html } = renderMarkdown("See [[2026-05-17-TranscriptionFixes]]", {
            resolveWikilink: () => null,
            resolveVaultNotePath: (name) =>
                name === "2026-05-17-TranscriptionFixes" ? "GenesisTools/2026-05-17-TranscriptionFixes.md" : null,
        });

        expect(html).toContain('data-obsidian-note="GenesisTools/2026-05-17-TranscriptionFixes.md"');
        expect(html).toContain("/obsidian?note=GenesisTools%2F2026-05-17-TranscriptionFixes.md");
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
        const md = "```\n[[Widgets]] should stay literal\n```";
        const { html } = renderMarkdown(md, noop);

        expect(html).toContain("[[Widgets]]");
        expect(html).not.toContain("dd-wikilink");
    });

    test("renders GFM-style alert callouts", () => {
        const md = "> [!warning]\n> something to watch";
        const { html } = renderMarkdown(md, noop);

        expect(html.toLowerCase()).toContain("markdown-alert");
        expect(html.toLowerCase()).toContain("warning");
    });

    test("maps Obsidian [!check] to the success color group", () => {
        const { html } = renderMarkdown("> [!check]\n> all green", noop);

        expect(html).toContain("markdown-alert markdown-alert-success");
        expect(html).toContain('data-callout="check"');
        expect(html).toContain("all green");
    });

    test("uses the custom callout title and parses inline markdown in it", () => {
        const md = "> [!check] Ověření 3 nezávislými **agenty** (2026-05-18)\n> body line";
        const { html } = renderMarkdown(md, noop);

        expect(html).toContain('class="markdown-alert-title"');
        expect(html).toContain("Ověření 3 nezávislými <strong>agenty</strong> (2026-05-18)");
        expect(html).not.toContain("[!check]");
        expect(html).toContain("body line");
    });

    test("falls back to the type name when no custom title is given", () => {
        const { html } = renderMarkdown("> [!summary]\n> x", noop);

        expect(html).toContain("markdown-alert-abstract");
        expect(html).toContain("<span>Summary</span>");
    });

    test("strips the fold marker and records fold state", () => {
        const { html } = renderMarkdown("> [!info]- collapsed\n> hidden", noop);

        expect(html).toContain('data-callout-fold="closed"');
        expect(html).toContain("<span>collapsed</span>");
        expect(html).not.toContain("]-");
    });

    test("leaves a plain blockquote (no [!type]) untouched", () => {
        const { html } = renderMarkdown("> just a quote", noop);

        expect(html).toContain("<blockquote>");
        expect(html).not.toContain("markdown-alert");
    });

    test("highlights fenced code blocks with hljs classes", () => {
        const md = "```ts\nconst x: number = 1;\n```";
        const { html } = renderMarkdown(md, noop);

        expect(html).toContain("hljs language-ts");
        expect(html).toContain("hljs-keyword");
    });

    // Only the languages that occur are registered. Any other one must stay a styling loss on
    // every path (QA, Obsidian render, share): escaped text, never a throw or raw HTML.
    test("renders an unregistered fence language as a plain escaped block", () => {
        const md = '```haskell\nmain = putStrLn "<script>alert(1)</script>"\n```';
        const { html } = renderMarkdown(md, noop);

        expect(html).toContain("<pre><code");
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).not.toContain("<script>");
        expect(html).not.toContain("hljs-");
    });

    test("hides comment-only HTML (include markers, stamps) and still escapes any other raw HTML", () => {
        const md = [
            '<!-- md:include sig=1a2b3c4d5e6f {{lines path="/x/a.ts" range="1-2"}} -->',
            "```ts",
            "const a = 1;",
            "```",
            "<!-- /md:include -->",
            "",
            "<!-- updated 2026-10-01 18:00: note -->",
            "",
            "<b>bold</b> <!-- inline comment -->",
        ].join("\n");
        const { html } = renderMarkdown(md, noop);

        expect(html).not.toContain("md:include");
        expect(html).not.toContain("updated 2026");
        expect(html).toContain('<code class="hljs language-ts">');
        expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
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

describe("details and summary", () => {
    test("a details block with blank lines inside becomes one fold with its body inside", () => {
        const md = "Before\n\n<details> <summary>Diff (testy)</summary>\n\n```diff\n-a\n+b\n```\n\n</details>\n\nAfter";
        const { html } = renderMarkdown(md, noop);

        expect(html).toContain('<details class="dd-details">');
        expect(html).toContain('<span class="dd-details-title">Diff (testy)</span>');
        expect(html.indexOf("dd-details-body")).toBeLessThan(html.indexOf("language-diff"));
        expect(html.indexOf("language-diff")).toBeLessThan(html.indexOf("</details>"));
        expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("After"));
        expect(html).not.toContain("&lt;details");
    });

    test("a one-block details, the open attribute and a nested fold all work", () => {
        const one = renderMarkdown("<details open><summary>S</summary>inline **body**</details>", noop).html;
        expect(one).toContain('<details class="dd-details" open>');
        expect(one).toContain("<strong>body</strong>");

        const nested = renderMarkdown(
            "<details>\n<summary>A</summary>\n\n<details>\n<summary>B</summary>\n\nx\n\n</details>\n\n</details>",
            noop
        ).html;
        expect(nested.match(/<details /g)?.length).toBe(2);
        expect(nested.match(/<\/details>/g)?.length).toBe(2);
    });

    test("markup in the summary and an unmatched tag stay inert", () => {
        const html = renderMarkdown(
            "<details><summary><img src=x onerror=alert(1)></summary>\n\ntext\n\n</details>\n\n<details>\n\nlost",
            noop
        ).html;
        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;details&gt;");
    });

    test("line anchors keep the fold in one block", () => {
        const html = renderMarkdown("<details>\n<summary>S</summary>\n\nbody\n\n</details>", {
            ...noop,
            lineAnchors: true,
        }).html;
        expect(html.match(/dd-src-block/g)?.length).toBe(1);
    });
});
