import { escapeHtml } from "@genesiscz/utils/string";

/**
 * Raw HTML in a shared note, rebuilt from an allowlist. The page is public, so nothing a note writes is
 * copied: each tag is read, and only an allowed tag with its allowed attributes is written back; every
 * other tag and all text between tags is escaped. Malformed input therefore ends up as text, never as markup.
 * The allowlist is the part of Obsidian's HTML that cannot run code, load a frame or cover the page:
 * no iframe, form, svg, style element, event handler or free-form `style`.
 */

export interface NoteHtmlImage {
    src: string;
    alt: string;
    width?: string;
    height?: string;
}

const TAG_RE =
    /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|<!--[\s\S]*?-->/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const TEXT_TAGS = [
    "b",
    "i",
    "em",
    "strong",
    "u",
    "s",
    "del",
    "ins",
    "mark",
    "small",
    "sub",
    "sup",
    "kbd",
    "code",
    "samp",
    "var",
    "cite",
    "q",
    "dfn",
    "abbr",
    "span",
];
const BLOCK_TAGS = [
    "div",
    "p",
    "center",
    "blockquote",
    "pre",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
];
const ALLOWED_TAGS = new Set([...TEXT_TAGS, ...BLOCK_TAGS, "a"]);
const VOID_TAGS = new Set(["br", "wbr", "hr"]);

const ALIGN_RE = /^(left|center|right|justify)$/i;
const SPAN_RE = /^\d{1,3}$/;
const COLOR_RE =
    /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\))$/i;
const STYLE_VALUES: Record<string, RegExp> = {
    color: COLOR_RE,
    "background-color": COLOR_RE,
    "text-align": ALIGN_RE,
    "font-weight": /^(normal|bold|bolder|lighter|[1-9]00)$/i,
    "font-style": /^(normal|italic)$/i,
    "text-decoration": /^(none|underline|line-through|overline)$/i,
};
const SAFE_HREF_RE = /^(https?:|mailto:|#)/i;

/** Text between tags: escaped, except an entity the note already wrote (`&amp;`, `&#8211;`), which stays one. */
function escapeText(text: string): string {
    return text
        .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function attributes(text: string): Map<string, string> {
    const attrs = new Map<string, string>();

    for (const match of text.matchAll(ATTR_RE)) {
        attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
    }

    return attrs;
}

/** `color: red; position: fixed` keeps only `color:red`. */
function safeStyle(style: string): string {
    const kept: string[] = [];

    for (const declaration of style.split(";")) {
        const at = declaration.indexOf(":");

        if (at === -1) {
            continue;
        }

        const property = declaration.slice(0, at).trim().toLowerCase();
        const value = declaration.slice(at + 1).trim();

        if (STYLE_VALUES[property]?.test(value)) {
            kept.push(`${property}:${value}`);
        }
    }

    return kept.join(";");
}

function openTag(name: string, attrs: Map<string, string>): string {
    const out: string[] = [];
    const align = attrs.get("align");
    const style = safeStyle(attrs.get("style") ?? "");
    const title = attrs.get("title");

    if (align && ALIGN_RE.test(align)) {
        out.push(`align="${align.toLowerCase()}"`);
    }

    if (style) {
        out.push(`style="${escapeHtml(style)}"`);
    }

    if (title) {
        out.push(`title="${escapeHtml(title)}"`);
    }

    if (name === "td" || name === "th") {
        for (const span of ["colspan", "rowspan"]) {
            const value = attrs.get(span);

            if (value && SPAN_RE.test(value)) {
                out.push(`${span}="${value}"`);
            }
        }
    }

    if (name === "ol") {
        const start = attrs.get("start");

        if (start && /^\d{1,6}$/.test(start)) {
            out.push(`start="${start}"`);
        }
    }

    if (name === "a") {
        const href = (attrs.get("href") ?? "").trim();

        if (SAFE_HREF_RE.test(href)) {
            out.push(`href="${escapeHtml(href)}"`);

            if (!href.startsWith("#")) {
                out.push('rel="noopener noreferrer"', 'target="_blank"');
            }
        }
    }

    return `<${name}${out.map((attr) => ` ${attr}`).join("")}>`;
}

/** The note's HTML with every tag rebuilt or escaped; `image` renders an `<img>` like a markdown image. */
export function sanitizeNoteHtml(html: string, image: (img: NoteHtmlImage) => string): string {
    let out = "";
    let last = 0;

    for (const match of html.matchAll(TAG_RE)) {
        out += escapeText(html.slice(last, match.index));
        last = match.index + match[0].length;

        // A comment is for the file, not the reader.
        if (match[0].startsWith("<!--")) {
            continue;
        }

        const closing = match[1] === "/";
        const name = match[2].toLowerCase();

        if (name === "img" && !closing) {
            const attrs = attributes(match[3]);
            const src = attrs.get("src");
            out += src
                ? image({ src, alt: attrs.get("alt") ?? "", width: attrs.get("width"), height: attrs.get("height") })
                : "";
            continue;
        }

        if (VOID_TAGS.has(name)) {
            out += closing ? "" : `<${name}>`;
            continue;
        }

        if (!ALLOWED_TAGS.has(name)) {
            out += escapeHtml(match[0]);
            continue;
        }

        out += closing ? `</${name}>` : openTag(name, attributes(match[3]));
    }

    return out + escapeText(html.slice(last));
}
