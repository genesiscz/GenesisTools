import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallCard } from "./ToolCallCard";

function renderMarkdown(content: string): string {
    return renderToStaticMarkup(<MarkdownRenderer content={content} />);
}

describe("MarkdownRenderer", () => {
    test("renders transcript HTML and executable destinations as inert text", () => {
        const html = renderMarkdown(
            [
                '<div><img src="x" onerror="globalThis.marker=1"></div>',
                "[unsafe](javascript:globalThis.marker=1)",
                "![unsafe image](javascript:globalThis.marker=1)",
                "[obfuscated](javascript&#58;globalThis.marker=1)",
            ].join("\n\n")
        );

        expect(html).not.toMatch(/<[^>]+\sonerror=/i);
        expect(html).not.toContain('<img src="x"');
        expect(html).not.toContain("<script");
        expect(html).not.toMatch(/(?:href|src)="javascript:/i);
        expect(html).toContain("unsafe");
        expect(html).toContain("&lt;div&gt;");
    });

    test("preserves normal Markdown, safe links, and known-language highlighting", () => {
        const html = renderMarkdown(
            "**bold**\n\n- one\n- two\n\n[safe](https://example.test/docs?q=1)\n\n```typescript\nconst ok = true;\n```"
        );

        expect(html).toContain("<strong>bold</strong>");
        expect(html).toContain("<li>one</li>");
        expect(html).toContain('href="https://example.test/docs?q=1"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).toContain("hljs-keyword");
    });

    test("keeps unlabelled and unknown fences escaped without language autodetection", () => {
        const source = 'SELECT marker FROM synthetic_records WHERE payload = "<img onerror=unsafe()>";';
        const unlabelled = renderMarkdown(`\`\`\`\n${source}\n\`\`\``);
        const unknown = renderMarkdown(`\`\`\`synthetic-unknown\n${source}\n\`\`\``);

        expect(unlabelled).not.toContain("hljs-keyword");
        expect(unknown).not.toContain("hljs-keyword");
        expect(unlabelled).toContain("&lt;img onerror=unsafe()&gt;");
        expect(unknown).toContain("&lt;img onerror=unsafe()&gt;");
    });
});

describe("ToolCallCard", () => {
    const structuredResult = SafeJSON.stringify([
        { type: "text", text: '**result marker** <img src="x" onerror="globalThis.marker=1">' },
    ]);

    test("does not render a closed tool body until expansion", () => {
        const closed = renderToStaticMarkup(
            <ToolCallCard name="Read" signature="synthetic.ts" resultContent={structuredResult} />
        );
        const open = renderToStaticMarkup(
            <ToolCallCard name="Read" signature="synthetic.ts" resultContent={structuredResult} defaultExpanded />
        );

        expect(closed).toContain("Read");
        expect(closed).not.toContain("result marker");
        expect(open).toContain("result marker");
        expect(open).not.toContain("onerror=");
    });
});
