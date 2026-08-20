import { decodeTeamsString } from "./decode";

const REPLY_ITEM_RE = /itemtype=["']http:\/\/schema\.skype\.com\/Reply["'][^>]*itemid=["']([^"']+)["']/i;
const REPLY_ITEM_RE_ALT = /itemid=["']([^"']+)["'][^>]*itemtype=["']http:\/\/schema\.skype\.com\/Reply["']/i;

export interface HtmlText {
    text: string;
    replyToId: string | null;
}

export function htmlToText(html: unknown): HtmlText {
    const raw = decodeTeamsString(html);

    if (!raw) {
        return { text: "", replyToId: null };
    }

    const replyToId = extractReplyToId(raw);
    let withoutQuote = raw.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, " ");
    withoutQuote = withoutQuote.replace(/<img\b[^>]*>/gi, (tag) => {
        if (/schema\.skype\.com\/AMSImage/i.test(tag)) {
            return " ";
        }

        const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1];
        return alt ? ` ${alt} ` : " ";
    });
    withoutQuote = withoutQuote.replace(/<br\s*\/?>/gi, "\n");
    withoutQuote = withoutQuote.replace(/<\/p>/gi, "\n");
    withoutQuote = withoutQuote.replace(/<\/div>/gi, "\n");
    withoutQuote = withoutQuote.replace(/<\/li>/gi, "\n");
    withoutQuote = withoutQuote.replace(/<[^>]+>/g, " ");
    const text = decodeHtmlEntities(withoutQuote)
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();

    return { text, replyToId };
}

export function extractReplyToId(html: string): string | null {
    const a = html.match(REPLY_ITEM_RE);
    const b = html.match(REPLY_ITEM_RE_ALT);
    const id = a?.[1] ?? b?.[1] ?? null;

    if (!id || id === "<Undefined>") {
        return null;
    }

    return id;
}

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#(\d+);/g, (_, n) => fromCodePointSafe(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => fromCodePointSafe(Number.parseInt(n, 16)))
        .replace(/&amp;/gi, "&");
}

function fromCodePointSafe(code: number): string {
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
        return "";
    }

    return String.fromCodePoint(code);
}
