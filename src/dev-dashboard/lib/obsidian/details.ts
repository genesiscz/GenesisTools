import type { Marked, MarkedExtension, Token, Tokens } from "marked";

/**
 * `<details><summary>Title</summary> … </details>` as a real fold. Raw HTML in a shared note is escaped
 * (the page is public), so these tags used to show up as literal text. They are read here as structure
 * instead: only the tag names, the `open` attribute and the summary text survive, and the summary
 * goes through the inline markdown renderer, so nothing in it can add markup.
 */

export interface DetailsToken {
    type: "details";
    raw: string;
    /** The summary rendered as inline HTML, already escaped by the markdown renderer. */
    summaryHtml: string;
    open: boolean;
    tokens: Token[];
}

const OPEN_RE = /^\s*<details(\s[^>]*)?>/i;
const OPEN_OPEN_ATTR_RE = /^\s*<details(?:\s[^>]*)?\sopen(?:[\s=>/]|$)/i;
const SUMMARY_RE = /<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i;
const CLOSE_ONLY_RE = /^\s*<\/details>\s*$/i;
const CLOSE_END_RE = /<\/details>\s*$/i;
const DEFAULT_SUMMARY = "Details";

function htmlText(token: Token): string | null {
    return token.type === "html" ? (token as Tokens.HTML).text : null;
}

function splitHead(text: string): { open: boolean; summary: string | null; rest: string } {
    const withoutTag = text.replace(OPEN_RE, "");
    const summary = SUMMARY_RE.exec(withoutTag);
    const rest = summary ? withoutTag.replace(SUMMARY_RE, "") : withoutTag;

    return { open: OPEN_OPEN_ATTR_RE.test(text), summary: summary ? summary[1].trim() : null, rest: rest.trim() };
}

function build(
    md: Marked,
    head: { open: boolean; summary: string | null; rest: string },
    raw: string,
    inner: Token[]
): DetailsToken {
    const summaryHtml = head.summary ? (md.parseInline(head.summary, { async: false }) as string) : DEFAULT_SUMMARY;
    const lead = head.rest ? [...md.lexer(head.rest)] : [];

    return { type: "details", raw, summaryHtml, open: head.open, tokens: [...lead, ...groupDetails(md, inner)] };
}

/** Replace each balanced run of `<details>` … `</details>` HTML tokens by one `details` token. An unmatched tag stays escaped text. */
export function groupDetails(md: Marked, tokens: Token[]): Token[] {
    const out: Token[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const text = htmlText(token);

        if (text === null || !OPEN_RE.test(text)) {
            out.push(token);
            continue;
        }

        const head = splitHead(text);

        if (CLOSE_END_RE.test(text)) {
            const body = head.rest.replace(CLOSE_END_RE, "").trim();
            out.push(build(md, { ...head, rest: body }, token.raw, []));
            continue;
        }

        let level = 1;
        let end = -1;

        for (let j = i + 1; j < tokens.length; j++) {
            const next = htmlText(tokens[j]);

            if (next === null) {
                continue;
            }

            if (OPEN_RE.test(next) && !CLOSE_END_RE.test(next)) {
                level++;
            } else if (CLOSE_ONLY_RE.test(next)) {
                level--;

                if (level === 0) {
                    end = j;
                    break;
                }
            }
        }

        if (end === -1) {
            out.push(token);
            continue;
        }

        const raw = tokens
            .slice(i, end + 1)
            .map((t) => t.raw)
            .join("");
        out.push(build(md, head, raw, tokens.slice(i + 1, end)));
        i = end;
    }

    return out;
}

export function detailsExtension(): MarkedExtension {
    return {
        extensions: [
            {
                name: "details",
                renderer(token) {
                    const t = token as unknown as DetailsToken;

                    return (
                        `<details class="dd-details"${t.open ? " open" : ""}>` +
                        `<summary class="dd-details-summary"><span class="dd-details-title">${t.summaryHtml}</span></summary>` +
                        `<div class="dd-details-body">${this.parser.parse(t.tokens)}</div></details>\n`
                    );
                },
            },
        ],
    };
}
