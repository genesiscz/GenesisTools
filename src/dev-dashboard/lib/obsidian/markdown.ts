import hljs from "highlight.js";
import type { MarkedExtension, Tokens } from "marked";
import { Marked } from "marked";
import markedAlert from "marked-alert";
import { markedHighlight } from "marked-highlight";
import markedKatex from "marked-katex-extension";

interface RenderOptions {
    resolveWikilink: (name: string) => string | null;
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

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => {
        const replacements: Record<string, string> = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
        };

        return replacements[char] ?? char;
    });
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

function extractMetadata(source: string): { markdown: string; tags: string[] } {
    const frontmatterMatch = source.match(FRONTMATTER_RE);

    if (frontmatterMatch) {
        return {
            markdown: source.slice(frontmatterMatch[0].length),
            tags: extractYamlTags(frontmatterMatch[1]),
        };
    }

    const tagsMatch = source.match(LEADING_TAGS_RE);

    if (tagsMatch) {
        return {
            markdown: source.slice(tagsMatch[0].length),
            tags: parseTagList(tagsMatch[1]),
        };
    }

    return { markdown: source, tags: [] };
}

function renderTagsHeader(tags: string[]): string {
    if (tags.length === 0) {
        return "";
    }

    const chips = tags.map((tag) => `<span class="dd-md-tag">#${escapeHtml(tag.replace(/^#/, ""))}</span>`).join("");

    return `<div class="dd-md-meta">${chips}</div>`;
}

function wikilinkExtension(resolve: (name: string) => string | null): MarkedExtension {
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
                    const slug = resolve(t.target);

                    if (slug) {
                        return `<a href="/share/${encodeURIComponent(slug)}" class="dd-wikilink">${escapeHtml(t.display)}</a>`;
                    }

                    return `<span class="dd-wikilink dd-wikilink-unresolved">${escapeHtml(t.display)}</span>`;
                },
            },
        ],
    };
}

function embedExtension(): MarkedExtension {
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

function buildMarked(opts: RenderOptions): Marked {
    return new Marked(
        { gfm: true, breaks: false },
        markedHighlight({
            langPrefix: "hljs language-",
            highlight: highlightCode,
        }),
        markedAlert(),
        markedKatex({ throwOnError: false, output: "html", strict: false }),
        embedExtension(),
        wikilinkExtension(opts.resolveWikilink),
        inlineTagExtension()
    );
}

const ALERT_PREFIX_RE = /^(\s*>\s*)\[!([A-Za-z]+)\]/gm;

function normalizeAlertCasing(input: string): string {
    return input.replace(ALERT_PREFIX_RE, (_full, lead: string, name: string) => `${lead}[!${name.toUpperCase()}]`);
}

export function renderMarkdown(source: string, opts: RenderOptions): RenderResult {
    const metadata = extractMetadata(source);
    const md = buildMarked(opts);
    const normalized = normalizeAlertCasing(metadata.markdown);
    const body = md.parse(normalized, { async: false }) as string;
    const tagsHeader = renderTagsHeader(metadata.tags);
    const hasMath = /class="katex(?:[ "])/.test(body);
    const hasMermaid = body.includes('<div class="mermaid">');

    return {
        html: `${tagsHeader}${body}`,
        hasMath,
        hasMermaid,
        tags: metadata.tags,
    };
}
