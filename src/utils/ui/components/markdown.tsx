import { Marked, type Tokens } from "marked";
import { memo, useMemo } from "react";

/**
 * Safe GFM markdown → HTML for LLM-generated content (same hardening as the
 * dev-dashboard board renderer): raw HTML in the source is escaped, never
 * injected; only http/https/mailto and relative/anchor hrefs survive; links
 * open in a new tab except in-page anchors (consumers intercept those, e.g.
 * `#cite-N` → player seek).
 */
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

/** Allow http/https/mailto and relative/anchor URLs; reject javascript:/data:/vbscript: etc. */
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
        // Regular function so `this.parser` binds to the renderer; the label is
        // rendered from its tokens (marked escapes it) rather than interpolating
        // raw text.
        link(token: Tokens.Link) {
            const label = this.parser.parseInline(token.tokens);

            if (!isSafeHref(token.href)) {
                return label;
            }

            const external = !token.href.startsWith("#");
            const targetAttrs = external ? ` target="_blank" rel="noreferrer noopener"` : "";
            return `<a href="${escapeAttr(token.href)}"${targetAttrs}>${label}</a>`;
        },
    },
});

export function renderMarkdown(md: string): string {
    return marked.parse(md, { async: false });
}

export interface MarkdownProps {
    md: string;
    /** Styling hook — the component ships no styles; theme via a prose class (e.g. `yt-md`). */
    className?: string;
    onClick?: React.MouseEventHandler<HTMLDivElement>;
}

export const Markdown = memo(function Markdown({ md, className, onClick }: MarkdownProps) {
    const html = useMemo(() => renderMarkdown(md), [md]);
    // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above — raw HTML escaped, hrefs protocol-filtered
    return <div className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
