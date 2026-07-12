import { Marked } from "marked";
import { memo, useMemo } from "react";

/** Full markdown for board cards (tables, fenced code, links, lists, blockquotes) — replaces
 *  md-lite for text/callout cards so agents can drop whole documents onto a board. Raw HTML in
 *  the source is escaped, never injected. Links open in a new tab. */
const marked = new Marked({
    gfm: true,
    breaks: true,
});

function escapeHtml(html: string): string {
    return html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

marked.use({
    renderer: {
        html({ text }: { text: string }) {
            return escapeHtml(text);
        },
        link({ href, text }: { href: string; text: string }) {
            return `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`;
        },
    },
});

export function renderBoardMd(md: string): string {
    return marked.parse(md, { async: false });
}

/** Memoized — a board can hold hundreds of text cards; parse once per md change. */
export const BoardMarkdown = memo(function BoardMarkdown({ md }: { md: string }) {
    const html = useMemo(() => renderBoardMd(md), [md]);
    return <div className="dd-board-md" dangerouslySetInnerHTML={{ __html: html }} />;
});
