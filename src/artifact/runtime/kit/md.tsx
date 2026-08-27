import { Marked, type Token, type Tokens } from "marked";
import { memo, useEffect, useMemo, useState } from "react";

/** Safe marked instance: raw HTML in the source is escaped, never injected. */
const marked = new Marked({ gfm: true, breaks: false });

function escapeHtml(html: string): string {
    return html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function isSafeHref(href: string): boolean {
    try {
        return SAFE_LINK_PROTOCOLS.has(new URL(href, "https://relative.invalid/").protocol);
    } catch {
        return false;
    }
}

marked.use({
    renderer: {
        html({ text }: Tokens.HTML | Tokens.Tag) {
            return escapeHtml(text);
        },
        link(token: Tokens.Link) {
            const label = this.parser.parseInline(token.tokens);

            if (!isSafeHref(token.href)) {
                return label;
            }

            const title = token.title ? ` title="${escapeHtml(token.title).replace(/"/g, "&quot;")}"` : "";

            return `<a href="${escapeHtml(token.href).replace(/"/g, "&quot;")}"${title} target="_blank" rel="noreferrer">${label}</a>`;
        },
    },
});

export function renderMarkdown(source: string): string {
    return marked.parse(source, { async: false });
}

export function renderMarkdownInline(source: string): string {
    return marked.parseInline(source, { async: false });
}

/** Typography wrapper for rendered markdown (shared by Md, MdViewer, and kit bodies). */
export const MD_BODY_CLASS =
    "akit-md max-w-none text-[0.95rem] leading-relaxed " +
    "[&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:border-b [&_h2]:border-line [&_h2]:pb-1 " +
    "[&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold " +
    "[&_a]:text-accent [&_a:hover]:underline " +
    "[&_code]:rounded [&_code]:border [&_code]:border-line [&_code]:bg-panel [&_code]:px-1 [&_code]:py-0.5 " +
    "[&_code]:font-mono [&_code]:text-[0.85em] " +
    "[&_pre]:overflow-x-auto [&_pre]:rounded-card [&_pre]:border [&_pre]:border-line [&_pre]:bg-panel [&_pre]:p-3 " +
    "[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
    "[&_blockquote]:border-l-2 [&_blockquote]:border-accent [&_blockquote]:pl-3 [&_blockquote]:text-dim " +
    "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-line " +
    "[&_th]:bg-panel [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-line " +
    "[&_td]:px-2 [&_td]:py-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 " +
    "[&_hr]:my-4 [&_hr]:border-line";

export interface MdProps {
    /** Markdown text to render. */
    children: string;
    className?: string;
}

/** Render a markdown string (block-level). */
export const Md = memo(function Md({ children, className }: MdProps) {
    const html = useMemo(() => renderMarkdown(children), [children]);

    return (
        <div
            className={`${MD_BODY_CLASS} ${className ?? ""}`}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: output of the escaping marked renderer above
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
});

/** Inline markdown (bold, code, links) with no block wrapper — for table cells and list items. */
export const MdInline = memo(function MdInline({ children, className }: MdProps) {
    const html = useMemo(() => renderMarkdownInline(children), [children]);

    return (
        <span
            className={`[&_code]:rounded [&_code]:border [&_code]:border-line [&_code]:bg-panel [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_a]:text-accent [&_a:hover]:underline ${className ?? ""}`}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: output of the escaping marked renderer above
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
});

interface MdSection {
    id: string;
    heading: string;
    html: string;
    text: string;
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function tokenText(tokens: Token[]): string {
    return tokens
        .map((t) => ("text" in t && typeof t.text === "string" ? t.text : ""))
        .join(" ")
        .replace(/\s+/g, " ");
}

/** Split a markdown document into sections at h1/h2 boundaries. */
function splitSections(source: string): MdSection[] {
    const tokens = marked.lexer(source);
    const sections: MdSection[] = [];
    let current: Token[] = [];
    let heading = "";

    const flush = (): void => {
        if (current.length === 0) {
            return;
        }

        const html = marked.parser(current);
        sections.push({
            id: `${sections.length}-${slugify(heading || "intro")}`,
            heading: heading || "(intro)",
            html,
            text: `${heading} ${tokenText(current)}`.toLowerCase(),
        });
        current = [];
    };

    for (const token of tokens) {
        if (token.type === "heading" && token.depth <= 2) {
            flush();
            heading = token.text;
        }

        current.push(token);
    }

    flush();

    return sections;
}

export interface MdViewerProps {
    /** Fetch the markdown from this URL (relative works when served). */
    src?: string;
    /** Or render this markdown string directly. */
    source?: string;
    title?: string;
    /** Show the filter box + TOC (default true). */
    chrome?: boolean;
    filterPlaceholder?: string;
}

/**
 * Markdown document viewer with a table of contents and a section filter —
 * the runtime replacement for build-time markdown inlining: point `src` at a
 * sibling .md and it stays fresh on every reload.
 */
export function MdViewer({ src, source, title, chrome = true, filterPlaceholder }: MdViewerProps) {
    const [fetched, setFetched] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");

    useEffect(() => {
        // `source` wins outright; and a NEW src must not show a stale error/body.
        setError(null);
        setFetched(null);

        if (!src || source !== undefined) {
            return;
        }

        let cancelled = false;
        fetch(src)
            .then(async (res) => {
                if (!res.ok) {
                    throw new Error(`${res.status} ${res.statusText}`);
                }

                const text = await res.text();

                if (!cancelled) {
                    setFetched(text);
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                }
            });

        return () => {
            cancelled = true;
        };
    }, [src, source]);

    const text = source ?? fetched;
    const sections = useMemo(() => (text ? splitSections(text) : []), [text]);
    const q = query.trim().toLowerCase();
    const visible = q ? sections.filter((s) => s.text.includes(q)) : sections;

    if (error) {
        return (
            <div className="rounded-card border border-err/50 bg-err/10 p-3 text-err">
                Failed to load {src}: {error}
            </div>
        );
    }

    if (!text) {
        return (
            <div className="animate-pulse rounded-card border border-line bg-panel/60 p-4 text-dim">Loading {src}…</div>
        );
    }

    if (!chrome) {
        return <Md>{text}</Md>;
    }

    return (
        <div>
            {title ? <h2 className="mb-2 text-lg font-semibold">{title}</h2> : null}
            <div className="mb-3 flex items-center gap-3">
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={filterPlaceholder ?? "filter sections…"}
                    className="w-72 max-w-full rounded-card border border-line bg-panel px-3 py-1.5 text-sm outline-none focus:border-accent"
                />
                <span className="text-xs text-dim">
                    {visible.length}/{sections.length} sections
                </span>
                {q ? (
                    <button
                        type="button"
                        onClick={() => setQuery("")}
                        className="rounded-card border border-line px-2 py-1 text-xs text-ink/90 hover:border-accent"
                    >
                        Clear
                    </button>
                ) : null}
            </div>
            <div className="flex gap-6">
                <nav className="sticky top-4 hidden max-h-[80dvh] w-56 shrink-0 self-start overflow-y-auto lg:block">
                    {visible.map((s) => (
                        <a
                            key={s.id}
                            href={`#${s.id}`}
                            className="block truncate rounded px-2 py-1 text-xs text-dim hover:bg-panel hover:text-ink"
                        >
                            {s.heading}
                        </a>
                    ))}
                </nav>
                <div className="min-w-0 flex-1">
                    {visible.map((s) => (
                        <section key={s.id} id={s.id} className="scroll-mt-4">
                            <div
                                className={MD_BODY_CLASS}
                                // biome-ignore lint/security/noDangerouslySetInnerHtml: output of the escaping marked renderer above
                                dangerouslySetInnerHTML={{ __html: s.html }}
                            />
                        </section>
                    ))}
                </div>
            </div>
        </div>
    );
}
