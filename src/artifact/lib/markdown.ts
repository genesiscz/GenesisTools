import { Marked, type Tokens } from "marked";
import { highlightCode } from "./highlight";

/**
 * The ONE markdown renderer for this tool. Artifact folders hold files the user
 * did not necessarily write (a downloaded report, a vault note synced from
 * elsewhere), and `serve --host` publishes them beyond loopback, so raw HTML in
 * a source file must never reach a viewer's origin as markup. Raw HTML is
 * escaped; link AND image hrefs are restricted to http/https/mailto.
 *
 * Kept free of node and React imports on purpose: the dev server, the builder
 * and the browser kit all render markdown, and they must agree.
 *
 * This is deliberately a SECOND renderer next to `src/utils/ui/components/markdown.tsx`,
 * which carries the same hardening. That one is a React component, so importing
 * it here would pull React into the node-side server and builder and into the
 * kit declaration emit (which runs with `types: []`). The two must be hardened
 * in lockstep: any escaping or protocol rule added there belongs here too.
 */
export const safeMarked = new Marked({ gfm: true, breaks: false });

const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/**
 * Local on purpose, and NOT `@genesiscz/utils/string`. That module also exports
 * escapeShellArg, which reads `process.platform`, so importing it here would
 * drag a node global into the browser kit and breaks the kit declaration emit
 * (`types: []`) outright. This file has to stay dependency-free.
 */
function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function isSafeHref(href: string): boolean {
    try {
        return SAFE_LINK_PROTOCOLS.has(new URL(href, "https://relative.invalid/").protocol);
    } catch {
        return false;
    }
}

/** Class marked's default code renderer would emit; the browser hydrators key on it. */
export const MERMAID_FENCE_CLASS = "language-mermaid";

safeMarked.use({
    renderer: {
        html({ text }: Tokens.HTML | Tokens.Tag) {
            return escapeHtml(text);
        },
        code({ text, lang }: Tokens.Code) {
            const language = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

            // A mermaid fence stays source text here. The kit's Md and the
            // markdown page chrome both swap it for the rendered SVG in the
            // browser (mermaid-core.ts); without them it reads as code.
            if (language === "mermaid") {
                return `<pre><code class="${MERMAID_FENCE_CLASS}">${escapeHtml(text)}</code></pre>\n`;
            }

            const lit = highlightCode(text, language);

            if (!lit) {
                const cls = language ? ` class="language-${escapeHtml(language)}"` : "";

                return `<pre><code${cls}>${escapeHtml(text)}</code></pre>\n`;
            }

            return `<pre><code class="hljs language-${lit.language}">${lit.html}</code></pre>\n`;
        },
        link(token: Tokens.Link) {
            const label = this.parser.parseInline(token.tokens);

            if (!isSafeHref(token.href)) {
                return label;
            }

            const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";

            return `<a href="${escapeHtml(token.href)}"${title} target="_blank" rel="noreferrer noopener">${label}</a>`;
        },
        image(token: Tokens.Image) {
            // Marked's default image renderer emits the href verbatim, so
            // `![x](javascript:…)` / `data:text/html…` would survive. Same
            // protocol allowlist as links; a rejected image degrades to its
            // escaped alt text.
            if (!isSafeHref(token.href)) {
                return escapeHtml(token.text);
            }

            const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";

            return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}"${title}>`;
        },
    },
});

export function renderMarkdown(source: string): string {
    return safeMarked.parse(source, { async: false });
}

export function renderMarkdownInline(source: string): string {
    return safeMarked.parseInline(source, { async: false });
}
