import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@genesiscz/utils/agents/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownRenderer } from "./MarkdownRenderer";
import { INITIAL_TIMELINE_MESSAGES, SessionTimeline, timelineWindow } from "./SessionTimeline";
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
        // The escaped source text may show "onerror" in a code block; only a live element or handler is a defect.
        expect(open).not.toMatch(/<img\b/i);
        expect(open).not.toMatch(/<[^>]+\sonerror=/i);
        expect(open).toContain("&lt;");
    });
});

describe("SessionTimeline window", () => {
    const messages = Array.from(
        { length: 120 },
        (_, index): AgentMessage => ({
            role: index % 2 === 0 ? "user" : "assistant",
            blocks: [{ type: "text", text: `message-${index}` }],
        })
    );

    test("renders the latest bounded window with a path to reveal every earlier message", () => {
        const html = renderToStaticMarkup(<SessionTimeline messages={messages} />);

        expect(html).toContain("Show 20 earlier messages");
        expect(html).not.toContain("message-19");
        expect(html).toContain("message-20");
        expect(html).toContain("message-119");
    });

    test("the pure window preserves global indexes and can reveal the full history", () => {
        expect(timelineWindow(messages, INITIAL_TIMELINE_MESSAGES).start).toBe(20);
        const all = timelineWindow(messages, messages.length);
        expect(all.start).toBe(0);
        expect(all.items).toEqual(messages);
    });

    test("show earlier reveals the complete history and preserves the scroll anchor", async () => {
        const dom = new JSDOM('<div id="root"></div>');
        const previousWindow = globalThis.window;
        const previousDocument = globalThis.document;
        const scrolls: number[] = [];
        Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
            configurable: true,
            get() {
                return this.children.length * 10;
            },
        });
        Object.defineProperty(dom.window, "scrollBy", {
            configurable: true,
            value: ({ top }: { top: number }) => scrolls.push(top),
        });
        Object.assign(globalThis, {
            window: dom.window,
            document: dom.window.document,
            IS_REACT_ACT_ENVIRONMENT: true,
        });

        const container = dom.window.document.getElementById("root");
        expect(container).not.toBeNull();
        const root = createRoot(container!);
        try {
            await act(async () => root.render(<SessionTimeline messages={messages.slice(0, 20)} />));
            await act(async () => root.render(<SessionTimeline messages={messages.slice(0, 21)} />));
            expect(container?.textContent).toContain("message-0");
            expect(container?.textContent).toContain("message-20");

            await act(async () => root.render(<SessionTimeline messages={messages} />));
            expect(container?.textContent).not.toContain("message-0");

            const button = [...(container?.querySelectorAll("button") ?? [])].find((node) =>
                node.textContent?.includes("earlier messages")
            );
            expect(button).toBeDefined();
            await act(async () => button?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));

            expect(container?.textContent).toContain("message-0");
            expect(container?.textContent).not.toContain("earlier messages");
            expect(scrolls).toEqual([190]);

            const appended = [
                ...messages,
                { role: "assistant", blocks: [{ type: "text", text: "message-120" }] } as AgentMessage,
            ];
            await act(async () => root.render(<SessionTimeline messages={appended} />));
            expect(container?.textContent).toContain("message-0");
            expect(container?.textContent).not.toContain("message-120");
            expect(container?.textContent).toContain("Jump to 1 newer message");
            expect(scrolls).toEqual([190]);

            const jump = [...(container?.querySelectorAll("button") ?? [])].find((node) =>
                node.textContent?.includes("newer message")
            );
            await act(async () => jump?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
            expect(container?.textContent).not.toContain("message-0");
            expect(container?.textContent).toContain("message-120");
        } finally {
            await act(async () => root.unmount());
            Object.assign(globalThis, { window: previousWindow, document: previousDocument });
            dom.window.close();
        }
    });
});
