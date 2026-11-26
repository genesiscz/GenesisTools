import { describe, expect, test } from "bun:test";
import markdownit from "./webview/markdown-it.min.js";
import { createMarkdownText } from "./webview/markdown-page.js";

describe("markdown page text passes", () => {
    test("extracts callouts and preserves source lines beside an adjacent list", () => {
        const text = createMarkdownText(markdownit);
        expect(text.extractCallouts("> [!warning] Alert\n1. Next")).toEqual({
            text: "@@GNCALLOUT0@@\n\n1. Next",
            callouts: [{ type: "warning", title: "Alert", body: "", start: 0 }],
            lineMap: [0, 1, 1],
        });
        const html = text.render("> [!note] Title\n> **Body**\n\n## After");
        expect(html).toContain('<h2 data-line="3" data-line-end="4" id="after">After</h2>');
        expect(html).toContain('class="markdown-alert markdown-alert-note"');
        expect(html).toContain("<strong>Body</strong>");
        expect(html).not.toContain("@@GNCALLOUT");
    });

    test("renders wikilinks, aliases, heading links and note embeds with the page rules", () => {
        const text = createMarkdownText(markdownit);
        const html = text.render("[[Other#Heading|Alias]] [[#Here]] ![[Other]]");
        expect(html).toContain('data-wikilink="Other#Heading">Alias</a>');
        expect(html).toContain('data-wikilink="#Here">Here</a>');
        expect(html).toContain('class="dd-wikilink dd-md-embed-stub" data-wikilink="Other"');
        expect(text.render("`[[Other]]` [[Other|<unsafe>]]")).toContain("&lt;unsafe&gt;</a>");
        expect(text.render("`[[Other]]`")).not.toContain("data-wikilink");
    });

    test("renders missing picture embeds without a DOM", () => {
        const text = createMarkdownText(markdownit);
        for (const note of ["![[diagram.png]]", "![[diagram.svg|600x400]]"]) {
            const html = text.render(note);
            expect(html).toContain('class="dd-md-embed-stub gn-img-missing"');
            expect(html).toContain('role="img"');
            expect(html).toContain("Picture not found: diagram.");
        }
        expect(text.render("![[Other]]")).toContain('data-wikilink="Other"');
    });

    test("renders task boxes at their original lines, including callout bodies", () => {
        const html = createMarkdownText(markdownit).render("> [!note]\n> - [x] Quoted\n\n- [ ] Open\n\nCode: [x] text");
        expect(html).toContain('data-task-line="1" data-task-text="Quoted" checked disabled');
        expect(html).toContain('data-task-line="3" data-task-text="Open" disabled');
        expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    });

    test("resets heading ids per render and keeps file names out of fuzzy web links", () => {
        const text = createMarkdownText(markdownit);
        const note = "## Same\n\n## Same\n\nPlan.md https://example.com/ [Local](file:///fixture.ts#L2)";
        const html = text.render(note);
        expect(html).toContain('id="same-1"');
        expect(html).not.toContain('href="http://Plan.md"');
        expect(html).toContain('href="https://example.com/"');
        expect(html).toContain('href="file:///fixture.ts#L2"');
        expect(text.render(note)).toBe(html);
    });

    test("balances multiline highlighted spans when numbering source lines", () => {
        const text = createMarkdownText(markdownit);
        expect(text.numberLines('<span class="comment">a\nb</span>\n')).toBe(
            '<span class="gn-ln" data-ln="1" style="--gn-ln-w:1ch"><span class="comment">a</span></span>' +
                '<span class="gn-ln" data-ln="2" style="--gn-ln-w:1ch"><span class="comment">b</span></span>'
        );
        expect(text.escapeHTML('<a title="x">&')).toBe("&lt;a title=&quot;x&quot;&gt;&amp;");
        expect(text.slug(" A Heading! ")).toBe("a-heading");
    });

    test("keeps raw inline HTML inside its own block and shows a placeholder tag as typed", () => {
        const text = createMarkdownText(markdownit);
        // The note of 2026-11-24: `<a>` and `<b>` were never closed, and the page drew the rest of it as a bold link.
        const note = text.render("- a link at a line (?plain=1#L<a>-<b>).\n\nNext paragraph must be plain.");
        expect(note).toContain("(?plain=1#L&lt;a&gt;-&lt;b&gt;).</li>");
        expect(note).not.toMatch(/<a>|<b>/);
        expect(note).toContain('<p data-line="2" data-line-end="3">Next paragraph must be plain.</p>');

        // HTML the note means stays HTML: pairs, void tags, and a tag with attributes, which ends with its paragraph.
        expect(text.render('Press <kbd>K</kbd>, <b>go</b>.<br> <span class="x">tinted\n\nAfter')).toBe(
            '<p data-line="0" data-line-end="1">Press <kbd>K</kbd>, <b>go</b>.<br> <span class="x">tinted</span></p>\n' +
                '<p data-line="2" data-line-end="3">After</p>\n'
        );
        // A closing tag with no opening tag, a tag still open when its parent closes, a cell's placeholder.
        const mixed = text.render("stray </b> and <b><i>misnested</b> text\n\n| <id> | <span/> |\n|---|---|");
        expect(mixed).toContain("stray &lt;/b&gt; and <b>&lt;i&gt;misnested</b> text");
        expect(mixed).toContain("<th>&lt;id&gt;</th>");
        expect(mixed).toContain("<th><span/></span></th>");
        // An html link still keeps linkify out of its text; a placeholder `<a>` does not.
        expect(text.render("<a>https://example.com</a> <a> https://example.org")).toBe(
            '<p data-line="0" data-line-end="1"><a>https://example.com</a> &lt;a&gt; ' +
                '<a href="https://example.org">https://example.org</a></p>\n'
        );
    });

    test("keeps structural closers from earlier blocks and slashes inside unquoted attributes", () => {
        const text = createMarkdownText(markdownit);
        const html = text.render("<details>\n<summary>Fold</summary>\n\ninside </details>\n\nAfter");
        expect(html).toContain("inside </details>");
        expect(html).not.toContain("&lt;/details&gt;");
        expect(text.render("See <span title=/docs/>the docs</span>.")).toContain("<span title=/docs/>the docs</span>");
        for (const tag of [
            "small",
            "sub",
            "sup",
            "mark",
            "del",
            "big",
            "font",
            "strike",
            "tt",
            "kbd",
            "samp",
            "var",
            "cite",
            "dfn",
            "abbr",
            "ins",
            "q",
            "bdi",
            "bdo",
        ]) {
            expect(text.render("<" + tag + ">\n\nAfter")).toContain("<" + tag + "></" + tag + ">\n");
        }
    });

    test("balances many empty tags and nonmatching closers without losing tokens", () => {
        const text = createMarkdownText(markdownit);
        const html = text.render("Start " + "<span/>".repeat(2000) + " End");
        expect(html.match(/<span\/><\/span>/g)).toHaveLength(2000);
        const unmatched = text.render("Start " + "<b title=x>".repeat(2000) + "</i>".repeat(2000));
        expect(unmatched.match(/&lt;\/i&gt;/g)).toHaveLength(2000);
        expect(unmatched.match(/<\/b>/g)).toHaveLength(2000);
    });

    test("ends a formatting tag a raw HTML block leaves open with that block and keeps a structural one open", () => {
        const text = createMarkdownText(markdownit);
        // A line holding only `<b>` is an HTML block, and the page drew every block after it bold.
        expect(text.render("<b>\n\nNext paragraph must be plain.")).toBe(
            '<b></b>\n<p data-line="2" data-line-end="3">Next paragraph must be plain.</p>\n'
        );
        expect(text.render("<em>\nstill in the block\n\nAfter")).toBe(
            '<em>\nstill in the block</em>\n<p data-line="3" data-line-end="4">After</p>\n'
        );
        // A wrapper that spans blocks stays as written, as CommonMark says.
        expect(text.render('<a href="https://example.com">\n\n![img](x.png)\n\n</a>')).toBe(
            '<a href="https://example.com">\n<p data-line="2" data-line-end="3"><img src="x.png" alt="img"></p>\n</a>'
        );
        expect(text.render('<div class="x">\n\ninside\n\n</div>')).toBe(
            '<div class="x">\n<p data-line="2" data-line-end="3">inside</p>\n</div>'
        );
        // Closed pairs, a misnested tag, an empty span, a comment and raw text.
        expect(text.render("<div><b>bold</b> <i>open\n\nAfter")).toContain("<div><b>bold</b> <i>open</i>\n");
        expect(text.render("<div><!-- <b> --><b><i>x</b>\n\nAfter")).toContain("<div><!-- <b> --><b><i>x</b></i>\n");
        expect(text.render("<div><span/> text\n\nAfter")).toContain("<div><span/></span> text\n");
        expect(text.render("<style>\n/* <b> */\n</style>\n\nAfter")).toContain("<style>\n/* <b> */\n</style>\n");
    });
});
