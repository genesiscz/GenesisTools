import { logger } from "@genesiscz/utils/logger";
import type { CheckResult, ParsedFeedItem, Watcher } from "../types";
import { describeFetchError, timedFetch } from "./http";

const MAX_ITEMS = 50;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_CODE_POINT = 0x10_ff_ff;

/** Out-of-range numeric entities stay as written; `String.fromCodePoint` would throw on them. */
function fromCodePoint(code: number, original: string): string {
    return Number.isFinite(code) && code >= 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : original;
}

/** Reads at most `MAX_FEED_BYTES`; a bigger body is cut there instead of buffered whole. */
async function readBounded(response: Response): Promise<{ text: string; truncated: boolean }> {
    const declared = Number(response.headers.get("content-length") ?? "");

    if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
        await response.body?.cancel();

        return { text: "", truncated: true };
    }

    if (!response.body) {
        return { text: await response.text(), truncated: false };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;

    while (true) {
        const { value, done } = await reader.read();

        if (done) {
            break;
        }

        total += value.byteLength;

        if (total > MAX_FEED_BYTES) {
            chunks.push(value.subarray(0, value.byteLength - (total - MAX_FEED_BYTES)));
            truncated = true;
            await reader.cancel();
            break;
        }

        chunks.push(value);
    }

    return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

function decodeEntities(value: string): string {
    return value
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (match, code: string) => fromCodePoint(Number(code), match))
        .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => fromCodePoint(Number.parseInt(code, 16), match))
        .replace(/&amp;/g, "&");
}

function stripTags(value: string): string {
    return decodeEntities(value)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tag(block: string, name: string): string | null {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));

    return match ? match[1].trim() : null;
}

function attr(block: string, name: string, attribute: string): string | null {
    const match = block.match(new RegExp(`<${name}\\b[^>]*\\b${attribute}=["']([^"']+)["'][^>]*/?>`, "i"));

    return match ? match[1] : null;
}

function toIso(value: string | null): string | null {
    if (!value) {
        return null;
    }

    const parsed = new Date(stripTags(value));

    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Tolerant RSS 2.0 / Atom reader for the handful of fields a watcher needs. A
 * regex pass is enough here: feeds are small, we only read text, and it keeps
 * the daemon free of an XML dependency.
 */
export function parseFeed(xml: string): { title: string | null; items: ParsedFeedItem[] } {
    const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
    const itemTag = isAtom ? "entry" : "item";
    const blocks = [...xml.matchAll(new RegExp(`<${itemTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${itemTag}>`, "gi"))].map(
        (match) => match[1]
    );
    // `search` answers -1 when the item tag is absent, and -1 is truthy: a
    // `|| xml.length` fallback there sliced the last byte off the document
    // instead of reading all of it.
    const itemAt = xml.search(new RegExp(`<${itemTag}[\\s>]`, "i"));
    const head = itemAt === -1 ? xml : xml.slice(0, itemAt);
    const title = tag(head, "title");
    const items: ParsedFeedItem[] = [];

    for (const block of blocks.slice(0, MAX_ITEMS)) {
        const itemTitle = stripTags(tag(block, "title") ?? "");
        const link = isAtom
            ? (attr(block, "link", "href") ?? stripTags(tag(block, "link") ?? ""))
            : stripTags(tag(block, "link") ?? "") || attr(block, "link", "href");
        const guid = stripTags(tag(block, isAtom ? "id" : "guid") ?? "") || link || itemTitle;

        if (!guid) {
            continue;
        }

        const summaryRaw = isAtom
            ? (tag(block, "summary") ?? tag(block, "content"))
            : (tag(block, "description") ?? tag(block, "content:encoded"));
        const summary = summaryRaw ? stripTags(summaryRaw).slice(0, 500) : null;
        const publishedAt = toIso(
            isAtom
                ? (tag(block, "published") ?? tag(block, "updated"))
                : (tag(block, "pubDate") ?? tag(block, "dc:date"))
        );

        items.push({ guid, title: itemTitle || guid, link: link || null, summary, publishedAt });
    }

    return { title: title ? stripTags(title) : null, items };
}

export function filterItems(items: ParsedFeedItem[], filters: string[] | undefined): ParsedFeedItem[] {
    if (!filters || filters.length === 0) {
        return items;
    }

    const needles = filters.map((filter) => filter.toLowerCase());

    return items.filter((item) => {
        const haystack = `${item.title} ${item.summary ?? ""}`.toLowerCase();

        return needles.some((needle) => haystack.includes(needle));
    });
}

/**
 * A feed is "up" when it downloads and parses. The items travel in `meta`;
 * the core diffs them against what it has already seen and delivers the new ones.
 */
export async function checkRss(watcher: Pick<Watcher, "target" | "config" | "timeoutMs">): Promise<CheckResult> {
    let response: Response;
    let latencyMs: number;

    try {
        const fetched = await timedFetch(
            watcher.target,
            {
                method: "GET",
                headers: {
                    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
                    // Some feeds (status.x.ai) sit behind a bot wall that lets browsers through.
                    "User-Agent":
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36 genesis-tools-monitor/1.0",
                },
            },
            watcher.timeoutMs
        );
        response = fetched.response;
        latencyMs = fetched.latencyMs;
    } catch (error) {
        logger.debug({ error, target: watcher.target }, "monitor: feed fetch failed");

        return {
            status: "down",
            latencyMs: null,
            httpStatus: null,
            detail: describeFetchError(error, watcher.timeoutMs),
        };
    }

    if (!response.ok) {
        // The scheduler polls forever, and an unread body keeps its socket
        // checked out of the fetch pool until GC. A feed answering 429 on a
        // 60 s watcher would leak 1440 undrained streams a day.
        await response.body?.cancel().catch((cancelError) => {
            logger.debug({ cancelError, target: watcher.target }, "monitor: feed body cancel failed");
        });

        return {
            status: "down",
            latencyMs,
            httpStatus: response.status,
            detail: `${response.status} ${response.statusText} · ${latencyMs} ms`,
        };
    }

    const { text: xml, truncated } = await readBounded(response);

    if (truncated) {
        return {
            status: "down",
            latencyMs,
            httpStatus: response.status,
            detail: `feed is larger than ${Math.round(MAX_FEED_BYTES / 1024 / 1024)} MB, not parsed`,
        };
    }

    const feed = parseFeed(xml);

    if (feed.items.length === 0 && !/<(rss|feed|channel)[\s>]/i.test(xml)) {
        return {
            status: "down",
            latencyMs,
            httpStatus: response.status,
            detail: "response is not an RSS or Atom feed",
        };
    }

    const items = filterItems(feed.items, watcher.config.itemFilter);
    const newest = items[0];
    const detail = newest
        ? `${items.length} item${items.length === 1 ? "" : "s"} · latest: ${newest.title.slice(0, 80)} · ${latencyMs} ms`
        : `feed parsed, no matching items · ${latencyMs} ms`;

    return {
        status: "up",
        latencyMs,
        httpStatus: response.status,
        detail,
        meta: { feedTitle: feed.title, items },
    };
}
