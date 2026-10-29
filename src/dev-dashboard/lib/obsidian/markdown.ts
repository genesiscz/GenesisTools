import { detailsExtension, groupDetails } from "@app/dev-dashboard/lib/obsidian/details";
import { buildObsidianNoteHref } from "@app/dev-dashboard/lib/obsidian/note-href";
import { sanitizeNoteHtml } from "@app/dev-dashboard/lib/obsidian/note-html";
import {
    anchorFor,
    FootnoteBook,
    headingSlug,
    type NoteProperty,
    obsidianSyntaxExtension,
    parseProperties,
    renderProperties,
} from "@app/dev-dashboard/lib/obsidian/obsidian-syntax";
import { escapeHtml } from "@genesiscz/utils/string";
import hljs from "highlight.js/lib/core";
import apache from "highlight.js/lib/languages/apache";
import applescript from "highlight.js/lib/languages/applescript";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import groovy from "highlight.js/lib/languages/groovy";
import http from "highlight.js/lib/languages/http";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import objectivec from "highlight.js/lib/languages/objectivec";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import properties from "highlight.js/lib/languages/properties";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { MarkedExtension, Token, Tokens } from "marked";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import markedKatex from "marked-katex-extension";

/**
 * A vault file the note references, already resolved and served under a content hash. `page` is a
 * note that has its own share page, so it stays an ordinary link.
 */
export interface ResolvedAsset {
    url: string;
    kind: "image" | "audio" | "video" | "pdf" | "json" | "markdown" | "code" | "page";
    name: string;
}

interface RenderOptions {
    resolveWikilink: (name: string) => string | null;
    resolveVaultNotePath?: (name: string) => string | null;
    /** Called with the raw target of `![[x]]`, `[[x]]`, `![](x)` and `[t](x)` (relative and file: hrefs only). */
    resolveAsset?: (target: string) => ResolvedAsset | null;
    /** Relative and file: links and images render as plain text, so a rendered attachment cannot reach further files. */
    inertLocalLinks?: boolean;
    /** Wrap each top-level block in `data-line-start`/`data-line-end` (1-based source lines, frontmatter counted). */
    lineAnchors?: boolean;
    /** Prefix for `/share/<slug>` links; a saved copy of a page sets the dashboard's public origin. */
    pageBaseUrl?: string;
}

export interface RenderResult {
    html: string;
    hasMath: boolean;
    hasMermaid: boolean;
    tags: string[];
}

interface WikilinkToken {
    type: "wikilink";
    raw: string;
    target: string;
    display: string;
}

interface EmbedToken {
    type: "embed";
    raw: string;
    target: string;
    display: string;
}

interface InlineTagToken {
    type: "inlineTag";
    raw: string;
    text: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const LEADING_TAGS_RE = /^tags:\s*(.+)\r?\n/i;
const WIKILINK_RE = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/;
const EMBED_RE = /^!\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/;
const INLINE_TAG_RE = /^#([A-Za-z][\w/-]*)(?=$|[\s.,;:!?)\]])/;

// marked (v5+) no longer strips dangerous URL schemes, so a note containing
// [x](javascript:...) or ![y](data:text/html;...) would execute on the public,
// auth-bypassed /share/:slug page. Allow only safe schemes + relative URLs.
const SAFE_LINK_SCHEME_RE = /^(?:https?:|mailto:|tel:|#|\/|\.{1,2}\/|[^:]*$)/i;
const SAFE_IMG_SRC_RE = /^(?:https?:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif);|#|\/|\.{1,2}\/|[^:]*$)/i;

interface ImageSize {
    width?: string;
    height?: string;
}

// Obsidian's size suffix on an image alt or embed label: `|360` or `|360x200`.
const OBSIDIAN_SIZE_RE = /^(?:(.*)\|)?(\d{1,5})(?:x(\d{1,5}))?$/s;
const HTML_DIMENSION_RE = /^(\d{1,5})(%?)$/;

/** `alt|360x200` → the alt without its suffix and the size; `alt` alone stays as it is. */
function splitObsidianSize(text: string): { label: string; size: ImageSize | undefined } {
    const match = OBSIDIAN_SIZE_RE.exec(text.trim());

    if (!match) {
        return { label: text, size: undefined };
    }

    return { label: (match[1] ?? "").trim(), size: { width: match[2], height: match[3] } };
}

/**
 * A pixel width is the `width` attribute. A percent goes into a style, since `width="50%"` is not valid HTML,
 * and so does every height: the page's `img { height: auto }` would otherwise cancel a height attribute.
 */
function sizeAttrs(size: ImageSize | undefined): string {
    if (!size) {
        return "";
    }

    const attrs: string[] = [];
    const styles: string[] = [];

    for (const [name, value] of [
        ["width", size.width],
        ["height", size.height],
    ] as const) {
        const match = value ? HTML_DIMENSION_RE.exec(value) : null;

        if (!match) {
            continue;
        }

        if (name === "width" && !match[2]) {
            attrs.push(`width="${match[1]}"`);
        } else {
            styles.push(`${name}:${match[1]}${match[2] || "px"}`);
        }
    }

    return [...attrs, ...(styles.length > 0 ? [`style="${styles.join(";")}"`] : [])].map((a) => ` ${a}`).join("");
}

function sanitizeUrl(href: string, allow: RegExp): string {
    // Strip ASCII control chars/whitespace that obfuscate the scheme
    // (e.g. `java\tscript:`), then enforce the scheme allowlist.
    const cleaned = Array.from(href)
        .filter((ch) => (ch.codePointAt(0) ?? 0) > 0x20)
        .join("");

    return allow.test(cleaned) ? cleaned : "#";
}

function isLocalHref(href: string): boolean {
    const trimmed = href.trim();

    if (/^file:/i.test(trimmed)) {
        return true;
    }

    return trimmed !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[/#?]/.test(trimmed);
}

const PANEL_ICONS: Record<string, string> = { json: "{ }", markdown: "¶", code: "</>" };

/** `labelHtml` is already escaped: link text comes out of marked as HTML, embed labels are escaped by the caller. */
const PDF_HEIGHT_RE = /[#&]height=(\d{2,4})/;

/**
 * `![[talk.mp3]]` is a player, `![[clip.mp4|480]]` a video, `![[doc.pdf#page=3&height=400]]` the PDF in a frame
 * (the fragment goes to the browser's viewer). A link to one, or a PDF in a saved page (a frame cannot show a
 * `data:` PDF), is a plain link that opens or downloads it.
 */
function renderMediaAsset(asset: ResolvedAsset, labelHtml: string, inline: boolean, size?: ImageSize): string {
    const url = escapeHtml(asset.url);
    const saved = asset.url.startsWith("data:");

    if (inline && asset.kind === "audio") {
        return `<audio class="dd-md-asset-audio" controls preload="metadata" src="${url}" title="${labelHtml}"></audio>`;
    }

    if (inline && asset.kind === "video") {
        return `<video class="dd-md-asset-video" controls preload="metadata" src="${url}" title="${labelHtml}"${sizeAttrs(size)}></video>`;
    }

    if (inline && asset.kind === "pdf" && !saved) {
        const height = PDF_HEIGHT_RE.exec(asset.url)?.[1];
        const heightStyle = height ? ` style="height:${height}px"` : "";

        return `<iframe class="dd-md-asset-pdf" src="${url}" title="${labelHtml}"${heightStyle}></iframe>`;
    }

    const download = saved ? ` download="${escapeHtml(asset.name)}"` : ' target="_blank" rel="noopener"';

    return `<a href="${url}" class="dd-md-asset-link"${download}>${labelHtml}</a>`;
}

function renderAsset(asset: ResolvedAsset, labelHtml: string, inline: boolean, size?: ImageSize): string {
    const url = escapeHtml(asset.url);

    if (asset.kind === "image") {
        if (inline) {
            return `<img src="${url}" alt="${labelHtml}" class="dd-md-asset-img"${sizeAttrs(size)} loading="lazy" />`;
        }

        return `<a href="${url}" class="dd-md-asset-link">${labelHtml}</a>`;
    }

    if (asset.kind === "page") {
        return `<a href="${url}" class="dd-wikilink">${labelHtml}</a>`;
    }

    if (asset.kind === "audio" || asset.kind === "video" || asset.kind === "pdf") {
        return renderMediaAsset(asset, labelHtml, inline, size);
    }

    const panelUrl = escapeHtml(asset.url.split("#")[0]);

    return (
        `<a href="${url}" class="dd-md-asset-chip dd-md-asset-${asset.kind}" data-asset-panel="${panelUrl}" data-asset-name="${escapeHtml(asset.name)}">` +
        `<span class="dd-md-asset-chip-icon" aria-hidden="true">${escapeHtml(PANEL_ICONS[asset.kind] ?? "")}</span><span>${labelHtml}</span></a>`
    );
}

function parseTagList(value: string): string[] {
    const trimmed = value.trim();
    const listValue = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

    return listValue
        .split(",")
        .map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
}

function extractYamlTags(frontmatter: string): string[] {
    const inlineMatch = frontmatter.match(/^tags:\s*(.+)$/im);

    if (inlineMatch) {
        return parseTagList(inlineMatch[1]);
    }

    const lines = frontmatter.split(/\r?\n/);
    const tagsIndex = lines.findIndex((line) => /^tags:\s*$/i.test(line));

    if (tagsIndex === -1) {
        return [];
    }

    const tags: string[] = [];

    for (const line of lines.slice(tagsIndex + 1)) {
        const match = line.match(/^\s*-\s*(.+)$/);

        if (!match) {
            break;
        }

        tags.push(match[1].trim().replace(/^["']|["']$/g, ""));
    }

    return tags.filter(Boolean);
}

function extractMetadata(source: string): { markdown: string; tags: string[]; properties: NoteProperty[] } {
    const frontmatterMatch = source.match(FRONTMATTER_RE);

    if (frontmatterMatch) {
        return {
            markdown: source.slice(frontmatterMatch[0].length),
            tags: extractYamlTags(frontmatterMatch[1]),
            // Tags already show as the chips above the note.
            properties: parseProperties(frontmatterMatch[1]).filter((prop) => prop.key.toLowerCase() !== "tags"),
        };
    }

    const tagsMatch = source.match(LEADING_TAGS_RE);

    if (tagsMatch) {
        return {
            markdown: source.slice(tagsMatch[0].length),
            tags: parseTagList(tagsMatch[1]),
            properties: [],
        };
    }

    return { markdown: source, tags: [], properties: [] };
}

function renderTagsHeader(tags: string[]): string {
    if (tags.length === 0) {
        return "";
    }

    const chips = tags.map((tag) => `<span class="dd-md-tag">#${escapeHtml(tag.replace(/^#/, ""))}</span>`).join("");

    return `<div class="dd-md-meta">${chips}</div>`;
}

function wikilinkExtension(opts: RenderOptions): MarkedExtension {
    return {
        extensions: [
            {
                name: "wikilink",
                level: "inline",
                start(src: string) {
                    return src.indexOf("[[");
                },
                tokenizer(src: string): WikilinkToken | undefined {
                    if (src.startsWith("![[")) {
                        return undefined;
                    }

                    const match = WIKILINK_RE.exec(src);

                    if (!match) {
                        return undefined;
                    }

                    return {
                        type: "wikilink",
                        raw: match[0],
                        target: match[1].trim(),
                        display: (match[2] ?? match[1]).trim(),
                    };
                },
                renderer(token: Tokens.Generic): string {
                    const t = token as unknown as WikilinkToken;
                    const hashAt = t.target.indexOf("#");
                    const note = hashAt === -1 ? t.target : t.target.slice(0, hashAt).trim();
                    const fragment = hashAt === -1 ? "" : t.target.slice(hashAt + 1).trim();
                    // Without an alias Obsidian shows `[[#Heading]]` as "Heading" and `[[Note#Heading]]` as "Note > Heading".
                    const display =
                        t.display !== t.target || !fragment ? t.display : note ? `${note} > ${fragment}` : fragment;

                    if (!note && fragment) {
                        return `<a href="#${escapeHtml(anchorFor(fragment))}" class="dd-wikilink">${escapeHtml(display)}</a>`;
                    }

                    // The whole target first, so a `#L12` line link still reaches its asset; then the note alone.
                    const html =
                        resolveWikilinkHtml(opts, t.target, display, "") ??
                        (fragment ? resolveWikilinkHtml(opts, note, display, anchorFor(fragment)) : null);

                    return html ?? `<span class="dd-wikilink dd-wikilink-unresolved">${escapeHtml(display)}</span>`;
                },
            },
        ],
    };
}

function embedExtension(opts: RenderOptions): MarkedExtension {
    return {
        extensions: [
            {
                name: "embed",
                level: "inline",
                start(src: string) {
                    return src.indexOf("![[");
                },
                tokenizer(src: string): EmbedToken | undefined {
                    const match = EMBED_RE.exec(src);

                    if (!match) {
                        return undefined;
                    }

                    return {
                        type: "embed",
                        raw: match[0],
                        target: match[1].trim(),
                        display: (match[2] ?? match[1]).trim(),
                    };
                },
                renderer(token: Tokens.Generic): string {
                    const t = token as unknown as EmbedToken;
                    const asset = opts.resolveAsset?.(t.target) ?? null;

                    if (asset) {
                        // `![[x.webp|300]]` carries a size, not a caption; `![[x.webp|caption|300]]` carries both.
                        const sizable = asset.kind === "image" || asset.kind === "video";
                        const { label: caption, size } =
                            sizable && t.display !== t.target
                                ? splitObsidianSize(t.display)
                                : { label: t.display, size: undefined };
                        const label =
                            t.display === t.target || caption === "" || (sizable && !size) ? asset.name : caption;

                        return renderAsset(asset, escapeHtml(label), true, size);
                    }

                    const target = escapeHtml(t.target);
                    const display = escapeHtml(t.display);

                    return `<div class="dd-md-embed-stub" data-target="${target}"><span class="dd-md-embed-icon">⧉</span><span class="dd-md-embed-label">${display}</span></div>`;
                },
            },
        ],
    };
}

function inlineTagExtension(): MarkedExtension {
    return {
        extensions: [
            {
                name: "inlineTag",
                level: "inline",
                start(src: string) {
                    const idx = src.search(/(^|[\s(])#[A-Za-z]/);

                    if (idx === -1) {
                        return undefined;
                    }

                    return idx + (src[idx] === "#" ? 0 : 1);
                },
                tokenizer(src: string): InlineTagToken | undefined {
                    const match = INLINE_TAG_RE.exec(src);

                    if (!match) {
                        return undefined;
                    }

                    return {
                        type: "inlineTag",
                        raw: match[0],
                        text: match[1],
                    };
                },
                renderer(token: Tokens.Generic): string {
                    const t = token as unknown as InlineTagToken;

                    return `<span class="dd-md-inline-tag">#${escapeHtml(t.text)}</span>`;
                },
            },
        ],
    };
}

// Obsidian callouts: every alias resolves to one of these color groups.
// The group drives the `markdown-alert-<group>` CSS class (palette lives in
// slate-grid.css for the in-app reader and share-template.ts for /share).
type CalloutGroup =
    | "note"
    | "abstract"
    | "info"
    | "todo"
    | "tip"
    | "success"
    | "question"
    | "warning"
    | "failure"
    | "danger"
    | "bug"
    | "example"
    | "quote";

const CALLOUT_ALIASES: Record<string, CalloutGroup> = {
    note: "note",
    abstract: "abstract",
    summary: "abstract",
    tldr: "abstract",
    info: "info",
    todo: "todo",
    tip: "tip",
    hint: "tip",
    important: "tip",
    idea: "tip",
    success: "success",
    check: "success",
    done: "success",
    question: "question",
    help: "question",
    faq: "question",
    warning: "warning",
    caution: "warning",
    attention: "warning",
    failure: "failure",
    fail: "failure",
    missing: "failure",
    danger: "danger",
    error: "danger",
    bug: "bug",
    example: "example",
    quote: "quote",
    cite: "quote",
};

// Compact lucide-style glyphs; stroke uses currentColor so the group color drives them.
const CALLOUT_ICONS: Record<CalloutGroup, string> = {
    note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    abstract:
        '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    todo: '<circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/>',
    tip: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.7.6 1 1.2 1 2.3h6c0-1.1.3-1.7 1-2.3A7 7 0 0 0 12 2Z"/>',
    success: '<path d="M20 6 9 17l-5-5"/>',
    question: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4M12 17h.01"/>',
    warning:
        '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    failure: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
    danger: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>',
    bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2M5 7l3 2M21 13h-5M3 13h5M19 19l-3-2M5 19l3-2M12 2v4"/>',
    example: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    quote: '<path d="M9 7H5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3v1a3 3 0 0 1-3 3M20 7h-4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3v1a3 3 0 0 1-3 3"/>',
};

function calloutIcon(group: CalloutGroup): string {
    return `<svg class="markdown-alert-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CALLOUT_ICONS[group]}</svg>`;
}

function titleCase(value: string): string {
    return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

interface CalloutToken {
    type: "callout";
    raw: string;
    group: CalloutGroup;
    rawType: string;
    fold: "" | "open" | "closed";
    titleTokens: Tokens.Generic[];
    titleText: string;
    tokens: Tokens.Generic[];
}

const CALLOUT_HEAD_RE = /^ {0,3}> ?\[!([A-Za-z][\w-]*)\]([-+])?[ \t]*([^\n]*)(?:\n|$)/;

// Obsidian callouts are GitHub-alert-shaped but with a far larger type set,
// alias groups, optional custom titles, and fold markers — marked-alert@2 only
// handles the 5 GH types and discards the custom title, so we own the whole
// blockquote-callout path here instead.
function obsidianCalloutExtension(): MarkedExtension {
    return {
        extensions: [
            {
                name: "callout",
                level: "block",
                start(src: string) {
                    const idx = src.search(/(^|\n) {0,3}> ?\[!/);

                    return idx === -1 ? undefined : idx;
                },
                tokenizer(src: string): CalloutToken | undefined {
                    const head = CALLOUT_HEAD_RE.exec(src);

                    if (!head) {
                        return undefined;
                    }

                    const group = CALLOUT_ALIASES[head[1].toLowerCase()];

                    if (!group) {
                        return undefined;
                    }

                    const lines = src.split("\n");
                    const block: string[] = [];

                    for (const line of lines) {
                        if (/^ {0,3}>/.test(line)) {
                            block.push(line);

                            continue;
                        }

                        break;
                    }

                    while (block.length > 0 && block[block.length - 1].trim() === "") {
                        block.pop();
                    }

                    const raw = block.join("\n");
                    const inner = raw.replace(/^ {0,3}> ?/gm, "");
                    const body = inner.replace(/^[^\n]*(?:\n|$)/, "");
                    const customTitle = head[3].trim();
                    const titleText = customTitle || titleCase(head[1]);
                    const fold: CalloutToken["fold"] = head[2] === "-" ? "closed" : head[2] === "+" ? "open" : "";

                    return {
                        type: "callout",
                        raw,
                        group,
                        rawType: head[1].toLowerCase(),
                        fold,
                        titleText,
                        titleTokens: this.lexer.inlineTokens(titleText),
                        tokens: this.lexer.blockTokens(body),
                    };
                },
                renderer(token: Tokens.Generic): string {
                    const t = token as unknown as CalloutToken;
                    const foldAttr = t.fold ? ` data-callout-fold="${t.fold}"` : "";
                    const title = this.parser.parseInline(t.titleTokens);
                    const bodyHtml = this.parser.parse(t.tokens);
                    const body = bodyHtml.trim() ? `<div class="markdown-alert-body">${bodyHtml}</div>` : "";

                    // `[!note]-` starts folded and `[!note]+` open, as in Obsidian: a native fold, no script.
                    if (t.fold) {
                        return (
                            `<details class="markdown-alert markdown-alert-${t.group}" data-callout="${escapeHtml(t.rawType)}"${foldAttr}${t.fold === "open" ? " open" : ""}>` +
                            `<summary class="markdown-alert-title">${calloutIcon(t.group)}<span>${title}</span></summary>` +
                            `${body}</details>\n`
                        );
                    }

                    return (
                        `<div class="markdown-alert markdown-alert-${t.group}" data-callout="${escapeHtml(t.rawType)}"${foldAttr}>` +
                        `<p class="markdown-alert-title">${calloutIcon(t.group)}<span>${title}</span></p>` +
                        `${body}</div>\n`
                    );
                },
            },
        ],
    };
}

// Core plus the languages that occur. Full highlight.js registers about 190 languages and made the
// QA page chunk 800 KB heavier. This list is every fence language highlight.js supports that
// appears in the QA log, the handoff logs and the vault (measured 2026-09-26); rendering 3637 of
// those texts gives the same HTML as full highlight.js. Any other language renders as a plain
// escaped block (`highlightCode` checks `getLanguage`), a styling loss only.
for (const [name, language] of Object.entries({
    apache,
    applescript,
    bash,
    c,
    cpp,
    css,
    diff,
    dockerfile,
    go,
    groovy,
    http,
    ini,
    java,
    javascript,
    json,
    kotlin,
    markdown,
    objectivec,
    php,
    plaintext,
    powershell,
    properties,
    python,
    ruby,
    rust,
    shell,
    sql,
    swift,
    typescript,
    xml,
    yaml,
})) {
    hljs.registerLanguage(name, language);
}

const KNOWN_HLJS_ALIASES: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    yml: "yaml",
    rb: "ruby",
    py: "python",
    rs: "rust",
};

function highlightCode(code: string, language: string): string {
    if (!language) {
        return escapeHtml(code);
    }

    if (language === "mermaid") {
        return `<div class="mermaid">${escapeHtml(code)}</div>`;
    }

    const alias = KNOWN_HLJS_ALIASES[language] ?? language;

    if (!hljs.getLanguage(alias)) {
        return escapeHtml(code);
    }

    try {
        return hljs.highlight(code, { language: alias, ignoreIllegals: true }).value;
    } catch {
        return escapeHtml(code);
    }
}

interface ImageRequest {
    href: string;
    alt: string;
    title?: string | null;
    size?: ImageSize;
}

function renderImage(opts: RenderOptions, image: ImageRequest): string {
    const local = isLocalHref(image.href);

    if (local && opts.inertLocalLinks) {
        return `<span class="dd-md-inert-link">${escapeHtml(image.alt || image.href)}</span>`;
    }

    const asset = local ? (opts.resolveAsset?.(image.href) ?? null) : null;

    if (asset) {
        return renderAsset(asset, escapeHtml(image.alt || asset.name), true, image.size);
    }

    const src = escapeHtml(sanitizeUrl(image.href, SAFE_IMG_SRC_RE));
    const title = image.title ? ` title="${escapeHtml(image.title)}"` : "";

    return `<img src="${src}" alt="${escapeHtml(image.alt)}"${title}${sizeAttrs(image.size)} />`;
}

function resolveWikilinkHtml(opts: RenderOptions, target: string, display: string, anchor: string): string | null {
    const hash = anchor ? `#${anchor}` : "";
    const asset = opts.resolveAsset?.(target) ?? null;

    if (asset) {
        return renderAsset(
            asset.kind === "page" ? { ...asset, url: `${asset.url}${hash}` } : asset,
            escapeHtml(display),
            false
        );
    }

    const vaultPath = opts.resolveVaultNotePath?.(target) ?? null;

    if (vaultPath) {
        const href = buildObsidianNoteHref(vaultPath);

        return `<a href="${escapeHtml(href)}" class="dd-wikilink" data-obsidian-note="${escapeHtml(vaultPath)}">${escapeHtml(display)}</a>`;
    }

    const slug = opts.resolveWikilink(target);

    if (slug) {
        return `<a href="${escapeHtml(opts.pageBaseUrl ?? "")}/share/${encodeURIComponent(slug)}${escapeHtml(hash)}" class="dd-wikilink">${escapeHtml(display)}</a>`;
    }

    return null;
}

function buildMarked(opts: RenderOptions, book: FootnoteBook): Marked {
    const usedSlugs = new Map<string, number>();

    return new Marked(
        { gfm: true, breaks: false },
        // The rendered HTML is served on the public, auth-bypassed /share/:slug
        // page. marked passes raw HTML in a note through verbatim, so a note
        // containing <script>/<img onerror> would execute in a visitor's
        // browser. Raw-HTML tokens are rebuilt from an allowlist instead; marked's
        // own element output and the trusted KaTeX/mermaid/wikilink extensions
        // are unaffected.
        {
            renderer: {
                // A comment-only token (`<!-- md:include … -->` around an excerpt, a json2md stamp, an
                // `<!-- updated … -->` note) is for the file, not the reader: Obsidian and Genesis hide it too.
                html: ({ text }) => {
                    if (text.replace(/<!--[\s\S]*?-->/g, "").trim() === "") {
                        return "";
                    }

                    // Raw HTML is rebuilt from an allowlist (note-html.ts); an `<img>` renders like a markdown image.
                    return sanitizeNoteHtml(text, (img) =>
                        renderImage(opts, {
                            href: img.src,
                            alt: img.alt,
                            size: { width: img.width, height: img.height },
                        })
                    );
                },
                heading(token: Tokens.Heading): string {
                    const base = headingSlug(token.text);
                    const seen = usedSlugs.get(base) ?? 0;
                    usedSlugs.set(base, seen + 1);
                    const id = seen === 0 ? base : `${base}-${seen}`;

                    return `<h${token.depth} id="${escapeHtml(id)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
                },
                link(token: Tokens.Link): string {
                    const local = isLocalHref(token.href);

                    if (local && opts.inertLocalLinks) {
                        return `<span class="dd-md-inert-link">${this.parser.parseInline(token.tokens)}</span>`;
                    }

                    const asset = local ? (opts.resolveAsset?.(token.href) ?? null) : null;

                    if (asset) {
                        return renderAsset(asset, this.parser.parseInline(token.tokens), false);
                    }

                    // On a shared page a local file the page does not serve (a code file outside the vault)
                    // has no address a visitor could open, so it shows as its label instead of a dead link.
                    if (local && opts.resolveAsset) {
                        return `<span class="dd-md-inert-link">${this.parser.parseInline(token.tokens)}</span>`;
                    }

                    const href = escapeHtml(sanitizeUrl(token.href, SAFE_LINK_SCHEME_RE));
                    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
                    const inner = this.parser.parseInline(token.tokens);

                    return `<a href="${href}"${title}>${inner}</a>`;
                },
                image(token: Tokens.Image): string {
                    const { label, size } = splitObsidianSize(token.text);

                    return renderImage(opts, { href: token.href, alt: label, title: token.title, size });
                },
            },
        },
        markedHighlight({
            langPrefix: "hljs language-",
            highlight: highlightCode,
        }),
        obsidianCalloutExtension(),
        obsidianSyntaxExtension(book),
        detailsExtension(),
        markedKatex({ throwOnError: false, output: "html", strict: false }),
        embedExtension(opts),
        wikilinkExtension(opts),
        inlineTagExtension()
    );
}

function lineCount(text: string): number {
    return text.split("\n").length - 1;
}

/**
 * The same output as `md.parse`, one top-level block at a time, so each block can carry the source
 * lines it came from. Inline references were already resolved by the lexer, and highlighting runs in
 * walkTokens, so both behave exactly as in a whole-document parse.
 */
function lexDocument(md: Marked, markdown: string): Token[] {
    const tokens = groupDetails(md, md.lexer(markdown));
    const walk = md.defaults.walkTokens;

    if (walk) {
        md.walkTokens(tokens, walk);
    }

    return tokens;
}

function renderWithLineAnchors(md: Marked, markdown: string, lineOffset: number): string {
    const tokens = lexDocument(md, markdown);
    let line = lineOffset;
    const parts: string[] = [];

    for (const token of tokens) {
        const start = line + 1;
        const newlines = lineCount(token.raw);
        line += newlines;

        if (token.type === "space") {
            continue;
        }

        const end = Math.max(start, start + newlines - (token.raw.endsWith("\n") ? 1 : 0));
        const html = md.parser([token]);

        parts.push(`<div class="dd-src-block" data-line-start="${start}" data-line-end="${end}">${html}</div>`);
    }

    return parts.join("\n");
}

/** Split highlight.js output into lines, closing and reopening spans so every line is balanced HTML. */
function splitHighlightedLines(html: string): string[] {
    const lines: string[] = [];
    const open: string[] = [];
    let current = "";

    for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
        if (part === "\n") {
            lines.push(current + "</span>".repeat(open.length));
            current = open.join("");
        } else if (part.startsWith("<span")) {
            open.push(part);
            current += part;
        } else if (part === "</span>") {
            open.pop();
            current += part;
        } else {
            current += part;
        }
    }

    lines.push(current + "</span>".repeat(open.length));

    return lines;
}

/** A highlighted code block with a number and a `data-line` on every line; the `hit` range is marked. */
export function renderCodeLines(options: {
    code: string;
    language: string;
    firstLine: number;
    hit?: { start: number; end: number };
}): string {
    const { code, language, firstLine, hit } = options;
    const lines = splitHighlightedLines(highlightCode(code.replace(/\n$/, ""), language));
    const body = lines
        .map((lineHtml, index) => {
            const number = firstLine + index;
            const isHit = hit !== undefined && number >= hit.start && number <= hit.end;

            return `<span class="dd-code-line${isHit ? " dd-line-hit" : ""}" data-line="${number}"><span class="dd-code-ln">${number}</span>${lineHtml || " "}</span>`;
        })
        .join("");

    return `<pre class="dd-code-lines"><code class="hljs language-${escapeHtml(language)}">${body}</code></pre>`;
}

export function renderMarkdown(source: string, opts: RenderOptions): RenderResult {
    const metadata = extractMetadata(source);
    const book = new FootnoteBook();
    const md = buildMarked(opts, book);
    const body = opts.lineAnchors
        ? renderWithLineAnchors(
              md,
              metadata.markdown,
              lineCount(source.slice(0, source.length - metadata.markdown.length))
          )
        : md.parser(lexDocument(md, metadata.markdown));
    const tagsHeader = renderTagsHeader(metadata.tags);
    const hasMath = /class="katex(?:[ "])/.test(body);
    const hasMermaid = body.includes('<div class="mermaid">');

    return {
        html: `${tagsHeader}${renderProperties(metadata.properties)}${body}${book.renderSection()}`,
        hasMath,
        hasMermaid,
        tags: metadata.tags,
    };
}
