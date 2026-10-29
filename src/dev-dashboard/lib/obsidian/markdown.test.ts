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
            '<font color="red">bold</font> <!-- inline comment -->',
        ].join("\n");
        const { html } = renderMarkdown(md, noop);

        expect(html).not.toContain("md:include");
        expect(html).not.toContain("updated 2026");
        expect(html).toContain('<code class="hljs language-ts">');
        expect(html).toContain("&lt;font color=&quot;red&quot;&gt;bold&lt;/font&gt;");
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

describe("image size", () => {
    const asset = {
        resolveWikilink: () => null,
        resolveAsset: (target: string) =>
            target.endsWith(".webp") ? { url: `/a/${target}`, kind: "image" as const, name: target } : null,
    };

    test("![alt|360](x) and ![alt|360x200](x) size a local image and drop the suffix from the alt", () => {
        const { html } = renderMarkdown("![shot|360](x.webp)\n\n![shot|360x200](x.webp)", asset);

        expect(html).toContain('<img src="/a/x.webp" alt="shot" class="dd-md-asset-img" width="360" loading="lazy" />');
        expect(html).toContain('alt="shot" class="dd-md-asset-img" width="360" style="height:200px"');
    });

    test("![[x|360]] and ![[x|caption|360x200]] size an embed", () => {
        const { html } = renderMarkdown("![[x.webp|360]]\n\n![[x.webp|Before|360x200]]\n\n![[x.webp|Caption]]", asset);

        expect(html).toContain('alt="x.webp" class="dd-md-asset-img" width="360" loading');
        expect(html).toContain('alt="Before" class="dd-md-asset-img" width="360" style="height:200px"');
        expect(html).toContain('alt="x.webp" class="dd-md-asset-img" loading');
    });

    test("a remote image takes the same size", () => {
        const { html } = renderMarkdown("![logo|120](https://example.org/l.png)", noop);

        expect(html).toContain('<img src="https://example.org/l.png" alt="logo" width="120" />');
    });

    test("<img src alt width height> renders as an image, local src resolved, percent as a style", () => {
        const { html } = renderMarkdown(
            'Inline <img src="x.webp" alt="half" width="50%"> here\n\n<img src=\'https://example.org/l.png\' width="80" height="40">',
            asset
        );

        expect(html).toContain('<img src="/a/x.webp" alt="half" class="dd-md-asset-img" style="width:50%" loading');
        expect(html).toContain('<img src="https://example.org/l.png" alt="" width="80" style="height:40px" />');
    });

    test("<img> with any other attribute or a script src stays escaped or neutered", () => {
        const { html } = renderMarkdown(
            '<img src="x.webp" onerror="alert(1)">\n\n<img src="javascript:alert(1)" width="10">\n\n<img src="x.webp" style="position:fixed">',
            asset
        );

        expect(html).toContain("&lt;img src=&quot;x.webp&quot; onerror");
        expect(html).toContain('<img src="#" alt="" width="10" />');
        expect(html).toContain("&lt;img src=&quot;x.webp&quot; style");
        expect(html).not.toContain('onerror="');
        expect(html).not.toContain("javascript:");
    });
});

describe("Obsidian syntax", () => {
    test("==highlight== becomes <mark> and keeps inline markdown inside", () => {
        const { html } = renderMarkdown("a ==**big** word== and a == b", noop);

        expect(html).toContain("<mark><strong>big</strong> word</mark>");
        expect(html).toContain("a == b");
    });

    test("%%comments%% are hidden, inline and as a block, but not inside code", () => {
        const { html } = renderMarkdown("keep %%hidden%% this\n\n%%\nblock secret\n%%\n\n`%%code%%`", noop);

        expect(html).toContain("keep  this");
        expect(html).not.toContain("hidden");
        expect(html).not.toContain("block secret");
        expect(html).toContain("<code>%%code%%</code>");
    });

    test("footnotes number in citation order and list under the note; inline footnotes too", () => {
        const md =
            "First[^b] then[^a] and again[^b] and ^[an *inline* one].\n\n[^a]: Alpha.\n[^b]: Beta with `code`.\n[^unused]: Nobody cites me.";
        const { html } = renderMarkdown(md, noop);

        expect(html).toContain('<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>');
        expect(html).toContain('<a href="#fn-2" id="fnref-2">2</a>');
        expect(html).toContain('again<sup class="footnote-ref"><a href="#fn-1">1</a></sup>');
        expect(html).toContain('<li id="fn-1">Beta with <code>code</code>.');
        expect(html).toContain('<li id="fn-2">Alpha.');
        expect(html).toContain('<li id="fn-3">an <em>inline</em> one');
        expect(html).not.toContain("Nobody cites me");
    });

    test("a citation with no definition stays text", () => {
        const { html } = renderMarkdown("See [^missing].", noop);

        expect(html).toContain("See [^missing].");
        expect(html).not.toContain("footnotes");
    });

    test("headings get ids, and [[#Heading]] and [[#^block]] link to them", () => {
        const md =
            "# My Heading!\n\n## My Heading\n\nA paragraph ^para-1\n\n[[#My Heading]] [[#^para-1|the paragraph]]";
        const { html } = renderMarkdown(md, noop);

        expect(html).toContain('<h1 id="my-heading">My Heading!</h1>');
        expect(html).toContain('<h2 id="my-heading-1">My Heading</h2>');
        expect(html).toContain('A paragraph<span class="dd-block-id" id="^para-1"></span>');
        expect(html).toContain('<a href="#my-heading" class="dd-wikilink">My Heading</a>');
        expect(html).toContain('<a href="#^para-1" class="dd-wikilink">the paragraph</a>');
    });

    test("[[Note#Heading]] links to the shared note at that heading", () => {
        const { html } = renderMarkdown("[[Other#Some Part]]", {
            resolveWikilink: (name) => (name === "Other" ? "abc" : null),
        });

        expect(html).toContain('<a href="/share/abc#some-part" class="dd-wikilink">Other &gt; Some Part</a>');
    });

    test("a folded callout is a native fold: [!note]- closed, [!tip]+ open", () => {
        const { html } = renderMarkdown("> [!note]- Closed\n> body\n\n> [!tip]+ Open\n> body", noop);

        expect(html).toContain(
            '<details class="markdown-alert markdown-alert-note" data-callout="note" data-callout-fold="closed">'
        );
        expect(html).toContain('<summary class="markdown-alert-title">');
        expect(html).toContain('data-callout-fold="open" open>');
    });

    test("plain formatting tags pass, anything with attributes or another name stays escaped", () => {
        const { html } = renderMarkdown(
            'Press <kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <u>under</u><br>next <span style="color:red">no</span> <script>x</script>',
            noop
        );

        expect(html).toContain("<kbd>Ctrl</kbd>+<kbd>C</kbd>");
        expect(html).toContain("H<sub>2</sub>O");
        expect(html).toContain("x<sup>2</sup>");
        expect(html).toContain("<u>under</u><br>next");
        expect(html).toContain("&lt;span style=");
        expect(html).toContain("&lt;script&gt;");
    });
});
