import { Marked, type Tokens } from "marked";

/**
 * The ONE markdown renderer for this tool. Artifact folders hold files the user
 * did not necessarily write (a downloaded report, a vault note synced from
 * elsewhere), and `serve --host` publishes them beyond loopback, so raw HTML in
 * a source file must never reach a viewer's origin as markup. Raw HTML is
 * escaped and link hrefs are restricted to http/https/mailto.
 *
 * Kept free of node and React imports on purpose: the dev server, the builder
 * and the browser kit all render markdown, and they must agree.
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

safeMarked.use({
    renderer: {
        html({ text }: Tokens.HTML | Tokens.Tag) {
            return escapeHtml(text);
        },
        link(token: Tokens.Link) {
            const label = this.parser.parseInline(token.tokens);

            if (!isSafeHref(token.href)) {
                return label;
            }

            const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";

            return `<a href="${escapeHtml(token.href)}"${title} target="_blank" rel="noreferrer">${label}</a>`;
        },
    },
});

export function renderMarkdown(source: string): string {
    return safeMarked.parse(source, { async: false });
}

export function renderMarkdownInline(source: string): string {
    return safeMarked.parseInline(source, { async: false });
}
