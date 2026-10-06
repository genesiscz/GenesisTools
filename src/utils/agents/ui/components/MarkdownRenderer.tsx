import { escapeHtml } from "@genesiscz/utils/string";
import hljs from "highlight.js";
import { Marked, type Tokens } from "marked";

import { useMemo } from "react";

function highlightCode(code: string, lang?: string): string {
    if (lang && hljs.getLanguage(lang)) {
        try {
            return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch (error) {
            console.debug("MarkdownRenderer: syntax highlighting failed", { error, lang, codeLength: code.length });
        }
    }

    return escapeHtml(code);
}

const marked = new Marked({ gfm: true });

function escapeAttribute(value: string): string {
    return escapeHtml(value).replace(/"/g, "&quot;");
}

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function isSafeHref(href: string): boolean {
    try {
        return SAFE_PROTOCOLS.has(new URL(href, "https://relative.invalid/").protocol);
    } catch {
        return false;
    }
}

const renderer = {
    code({ text, lang }: Tokens.Code): string {
        const highlighted = highlightCode(text, lang || undefined);
        const dot = (color: string) =>
            `<div style="width:12px;height:12px;border-radius:50%;background:${color};flex-shrink:0"></div>`;
        const dotsBar =
            `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.06)">` +
            dot("#ef4444") +
            dot("#eab308") +
            dot("#22c55e") +
            (lang
                ? `<span style="flex:1;text-align:center;font-size:0.75rem;opacity:0.5;font-family:var(--font-mono,monospace)">${escapeHtml(lang)}</span>`
                : `<span style="flex:1"></span>`) +
            `</div>`;
        return `<div class="md-code-block">${dotsBar}<pre class="hljs"><code>${highlighted}</code></pre></div>`;
    },

    codespan({ text }: Tokens.Codespan): string {
        return `<code class="md-inline-code">${escapeHtml(text)}</code>`;
    },

    html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text);
    },

    link(token: Tokens.Link): string {
        const label = marked.parseInline(token.text, { async: false });

        if (!isSafeHref(token.href)) {
            return label;
        }

        const external = !token.href.startsWith("#");
        const target = external ? ' target="_blank" rel="noopener noreferrer"' : "";
        const title = token.title ? ` title="${escapeAttribute(token.title)}"` : "";
        return `<a href="${escapeAttribute(token.href)}"${title}${target}>${label}</a>`;
    },

    image(token: Tokens.Image): string {
        if (!isSafeHref(token.href)) {
            return escapeHtml(token.text);
        }

        const title = token.title ? ` title="${escapeAttribute(token.title)}"` : "";
        return `<img src="${escapeAttribute(token.href)}" alt="${escapeAttribute(token.text)}"${title}>`;
    },
};

marked.use({ renderer });

function renderMarkdownToHtml(text: string): string {
    try {
        const result = marked.parse(text, { async: false });

        if (typeof result !== "string") {
            return escapeHtml(text);
        }

        return result;
    } catch {
        return escapeHtml(text);
    }
}

interface MarkdownRendererProps {
    content: string;
    className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
    const html = useMemo(() => renderMarkdownToHtml(content), [content]);

    // biome-ignore lint/security/noDangerouslySetInnerHtml: renderer escapes raw HTML and filters link/image protocols above
    return <div className={`md-prose ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
