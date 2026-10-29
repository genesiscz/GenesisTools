import { escapeHtml } from "@genesiscz/utils/string";
import type { MarkedExtension, Token, Tokens } from "marked";

/**
 * Obsidian syntax that marked's GFM does not know: `==highlight==`, `%%comments%%`, footnotes (`[^id]`,
 * `[^id]: text`, inline `^[text]`), block ids (`^id`) and heading anchors. Everything here renders
 * from tokens, so a note still cannot add markup of its own.
 */

/** The anchor a heading gets and a `[[#Heading]]` link points at: the same function on both sides. */
export function headingSlug(text: string): string {
    return (
        text
            .trim()
            .toLowerCase()
            .replace(/<[^>]*>/g, "")
            .replace(/[^\p{L}\p{N}\s_-]/gu, "")
            .replace(/\s+/g, "-") || "section"
    );
}

/** `[[#Heading]]`, `[[#^block]]`: the fragment a page uses for that heading or block id. */
export function anchorFor(fragment: string): string {
    return fragment.startsWith("^") ? fragment : headingSlug(fragment);
}

interface HighlightToken {
    type: "highlight";
    raw: string;
    tokens: Token[];
}

interface FootnoteRefToken {
    type: "footnoteRef";
    raw: string;
    id: string;
    /** Set for an inline footnote `^[text]`: its own body. */
    tokens?: Token[];
}

interface FootnoteDefToken {
    type: "footnoteDef";
    raw: string;
    id: string;
    tokens: Token[];
}

interface BlockIdToken {
    type: "lineBlockId" | "inlineBlockId";
    raw: string;
    id: string;
}

const HIGHLIGHT_RE = /^==(?=\S)([\s\S]*?\S)==(?!=)/;
const BLOCK_COMMENT_RE = /^ {0,3}%%[\s\S]*?%%[ \t]*(?:\n|$)/;
const INLINE_COMMENT_RE = /^%%[\s\S]+?%%/;
const FOOTNOTE_DEF_RE = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]{2,}|\t)[^\n]*)*)(?:\n|$)/;
const FOOTNOTE_REF_RE = /^\[\^([^\]\s]+)\]/;
const INLINE_FOOTNOTE_RE = /^\^\[((?:[^[\]\n]|\[[^\]\n]*\])+)\]/;
const BLOCK_ID = "[A-Za-z0-9-]+";
const INLINE_BLOCK_ID_RE = new RegExp(`^[ \\t]\\^(${BLOCK_ID})(?=\\n|$)`);
const LINE_BLOCK_ID_RE = new RegExp(`^ {0,3}\\^(${BLOCK_ID})[ \\t]*(?:\\n|$)`);

function search(src: string, re: RegExp): number | undefined {
    const index = src.search(re);

    return index === -1 ? undefined : index;
}

/**
 * Where a block extension may start inside a paragraph: right after a newline. marked calls a block `start`
 * with the paragraph minus its first character, so a `^` anchor would match mid-line and split the paragraph.
 */
function lineStart(src: string, linePattern: string): number | undefined {
    const index = src.search(new RegExp(`\\n${linePattern}`));

    return index === -1 ? undefined : index + 1;
}

/** One render's footnotes: ids defined anywhere in the note, numbers in the order they are first cited. */
export class FootnoteBook {
    readonly defined = new Set<string>();
    private readonly numbers = new Map<string, number>();
    private readonly bodies = new Map<string, string>();
    private inlineCount = 0;

    nextInlineId(): string {
        this.inlineCount++;

        return `^inline-${this.inlineCount}`;
    }

    /** The number for a citation; the first citation of an id gets the next one. */
    cite(id: string): { number: number; first: boolean } {
        const known = this.numbers.get(id);

        if (known !== undefined) {
            return { number: known, first: false };
        }

        const number = this.numbers.size + 1;
        this.numbers.set(id, number);

        return { number, first: true };
    }

    setBody(id: string, html: string): void {
        this.bodies.set(id, html);
    }

    /** The list under the note, in citation order. A footnote nobody cites is left out, as Obsidian does. */
    renderSection(): string {
        if (this.numbers.size === 0) {
            return "";
        }

        const items = [...this.numbers].map(
            ([id, number]) =>
                `<li id="fn-${number}">${this.bodies.get(id) ?? ""} <a href="#fnref-${number}" class="footnote-backref" aria-label="Back to the text">↩</a></li>`
        );

        return `<section class="footnotes" aria-label="Footnotes"><hr><ol>${items.join("")}</ol></section>`;
    }
}

export function obsidianSyntaxExtension(book: FootnoteBook): MarkedExtension {
    return {
        extensions: [
            {
                name: "blockComment",
                level: "block",
                start: (src: string) => lineStart(src, " {0,3}%%"),
                tokenizer(src: string) {
                    const match = BLOCK_COMMENT_RE.exec(src);

                    return match ? { type: "blockComment", raw: match[0] } : undefined;
                },
                renderer: () => "",
            },
            {
                name: "footnoteDef",
                level: "block",
                start: (src: string) => lineStart(src, " {0,3}\\[\\^[^\\]\\s]+\\]:"),
                tokenizer(src: string): FootnoteDefToken | undefined {
                    const match = FOOTNOTE_DEF_RE.exec(src);

                    if (!match) {
                        return undefined;
                    }

                    book.defined.add(match[1]);
                    const text = match[2].replace(/\n(?:[ \t]{2,}|\t)/g, "\n").trim();

                    return { type: "footnoteDef", raw: match[0], id: match[1], tokens: this.lexer.inlineTokens(text) };
                },
                renderer(token: Tokens.Generic): string {
                    const t = token as unknown as FootnoteDefToken;
                    book.setBody(t.id, this.parser.parseInline(t.tokens));

                    return "";
                },
            },
            {
                name: "lineBlockId",
                level: "block",
                start: (src: string) => lineStart(src, ` {0,3}\\^${BLOCK_ID}[ \\t]*(?:\\n|$)`),
                tokenizer(src: string): BlockIdToken | undefined {
                    const match = LINE_BLOCK_ID_RE.exec(src);

                    return match ? { type: "lineBlockId", raw: match[0], id: match[1] } : undefined;
                },
                renderer(token: Tokens.Generic): string {
                    return `<span class="dd-block-id" id="^${escapeHtml((token as unknown as BlockIdToken).id)}"></span>`;
                },
            },
            {
                name: "inlineComment",
                level: "inline",
                start: (src: string) => search(src, /%%/),
                tokenizer(src: string) {
                    const match = INLINE_COMMENT_RE.exec(src);

                    return match ? { type: "inlineComment", raw: match[0] } : undefined;
                },
                renderer: () => "",
            },
            {
                name: "highlight",
                level: "inline",
                start: (src: string) => search(src, /==(?=\S)/),
                tokenizer(src: string): HighlightToken | undefined {
                    const match = HIGHLIGHT_RE.exec(src);

                    return match
                        ? { type: "highlight", raw: match[0], tokens: this.lexer.inlineTokens(match[1]) }
                        : undefined;
                },
                renderer(token: Tokens.Generic): string {
                    return `<mark>${this.parser.parseInline((token as unknown as HighlightToken).tokens)}</mark>`;
                },
            },
            {
                name: "footnoteRef",
                level: "inline",
                start: (src: string) => search(src, /\[\^|\^\[/),
                tokenizer(src: string): FootnoteRefToken | undefined {
                    const ref = FOOTNOTE_REF_RE.exec(src);

                    if (ref) {
                        return { type: "footnoteRef", raw: ref[0], id: ref[1] };
                    }

                    const inline = INLINE_FOOTNOTE_RE.exec(src);

                    if (inline) {
                        const id = book.nextInlineId();
                        book.defined.add(id);

                        return { type: "footnoteRef", raw: inline[0], id, tokens: this.lexer.inlineTokens(inline[1]) };
                    }

                    return undefined;
                },
                renderer(token: Tokens.Generic): string {
                    const t = token as unknown as FootnoteRefToken;

                    // A citation with no definition is plain text, as Obsidian shows it.
                    if (!book.defined.has(t.id)) {
                        return escapeHtml(t.raw);
                    }

                    const { number, first } = book.cite(t.id);

                    if (t.tokens) {
                        book.setBody(t.id, this.parser.parseInline(t.tokens));
                    }

                    const idAttr = first ? ` id="fnref-${number}"` : "";

                    return `<sup class="footnote-ref"><a href="#fn-${number}"${idAttr}>${number}</a></sup>`;
                },
            },
            {
                name: "inlineBlockId",
                level: "inline",
                start: (src: string) => search(src, new RegExp(`[ \\t]\\^${BLOCK_ID}(?:\\n|$)`)),
                tokenizer(src: string): BlockIdToken | undefined {
                    const match = INLINE_BLOCK_ID_RE.exec(src);

                    return match ? { type: "inlineBlockId", raw: match[0], id: match[1] } : undefined;
                },
                renderer(token: Tokens.Generic): string {
                    return `<span class="dd-block-id" id="^${escapeHtml((token as unknown as BlockIdToken).id)}"></span>`;
                },
            },
        ],
    };
}
