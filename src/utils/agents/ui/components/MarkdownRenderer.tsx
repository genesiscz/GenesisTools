import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import { marked as markedRaw } from "marked";

// tsgo resolves `marked` as a function overload, missing .use() and .parse()
// Cast to the full API shape that marked v17 exports at runtime
const marked = markedRaw as unknown as {
    parse: (src: string, options?: { async?: false }) => string;
    use: (ext: { renderer: Record<string, unknown> }) => void;
};

import { useMemo } from "react";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("js", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("jsx", typescript);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("zsh", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);

function highlightCode(code: string, lang?: string): string {
    if (lang && hljs.getLanguage(lang)) {
        try {
            return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch {
            // Highlight failed, fall through to auto
        }
    }

    try {
        return hljs.highlightAuto(code).value;
    } catch {
        return escapeHtml(code);
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Use marked's renderer override API (works across all marked versions)
const renderer = {
    code({ text, lang }: { text: string; lang?: string }): string {
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

    codespan({ text }: { text: string }): string {
        return `<code class="md-inline-code">${escapeHtml(text)}</code>`;
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

    // biome-ignore lint/security/noDangerouslySetInnerHtml: rendering our own markdown, not user-supplied HTML
    return <div className={`md-prose ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
