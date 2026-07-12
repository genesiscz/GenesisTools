import { Marked, type Tokens } from "marked";
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

/** Attribute-context escape: escapeHtml plus the double-quote that would break out of href="…". */
function escapeAttr(value: string): string {
    return escapeHtml(value).replace(/"/g, "&quot;");
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Allow http/https/mailto and relative/anchor URLs; reject javascript:/data:/vbscript: etc.
 *  Relative and anchor hrefs resolve against the placeholder base to https:, so they pass. */
function isSafeHref(href: string): boolean {
    try {
        return SAFE_LINK_PROTOCOLS.has(new URL(href, "https://relative.invalid/").protocol);
    } catch {
        return false;
    }
}

marked.use({
    renderer: {
        html({ text }: { text: string }) {
            return escapeHtml(text);
        },
        // Regular function so `this.parser` binds to the renderer; the label is rendered from its
        // tokens (marked escapes it) rather than interpolating the raw text — a label like
        // `<img onerror=…>` must never reach dangerouslySetInnerHTML unescaped.
        link(token: Tokens.Link) {
            const label = this.parser.parseInline(token.tokens);

            if (!isSafeHref(token.href)) {
                return label;
            }

            return `<a href="${escapeAttr(token.href)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
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
