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
});
