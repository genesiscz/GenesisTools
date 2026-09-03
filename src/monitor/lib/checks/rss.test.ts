import { describe, expect, test } from "bun:test";
import { checkRss, filterItems, parseFeed } from "./rss";

const RSS = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>SpaceXAI System Status</title>
    <link>https://status.x.ai</link>
    <item>
      <title>[Grok (iOS)] Models outage</title>
      <link>https://status.x.ai/ios-app/INCc33a8af</link>
      <guid isPermaLink="false">INCc33a8af</guid>
      <description><![CDATA[<h3>Status: ACTIVE</h3><p>Severity: outage</p>]]></description>
      <pubDate>Thu, 03 Sep 2026 13:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Resolved &amp; closed</title>
      <link>https://status.x.ai/web/INC1</link>
      <guid>INC1</guid>
      <pubDate>Wed, 02 Sep 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Claude Status - Incident History</title>
  <entry>
    <id>tag:status.claude.com,2005:Incident/1</id>
    <published>2026-09-03T13:26:04Z</published>
    <title>Elevated errors on claude.ai</title>
    <link rel="alternate" href="https://status.claude.com/incidents/abc"/>
    <content type="html">&lt;p&gt;Investigating.&lt;/p&gt;</content>
  </entry>
</feed>`;

describe("parseFeed", () => {
    test("reads RSS 2.0 items with guid, link, date and stripped description", () => {
        const feed = parseFeed(RSS);

        expect(feed.title).toBe("SpaceXAI System Status");
        expect(feed.items).toHaveLength(2);
        expect(feed.items[0]).toEqual({
            guid: "INCc33a8af",
            title: "[Grok (iOS)] Models outage",
            link: "https://status.x.ai/ios-app/INCc33a8af",
            summary: "Status: ACTIVE Severity: outage",
            publishedAt: "2026-09-03T13:30:00.000Z",
        });
        expect(feed.items[1].title).toBe("Resolved & closed");
    });

    test("reads Atom entries with id, alternate link and content", () => {
        const feed = parseFeed(ATOM);

        expect(feed.title).toBe("Claude Status - Incident History");
        expect(feed.items).toEqual([
            {
                guid: "tag:status.claude.com,2005:Incident/1",
                title: "Elevated errors on claude.ai",
                link: "https://status.claude.com/incidents/abc",
                summary: "Investigating.",
                publishedAt: "2026-09-03T13:26:04.000Z",
            },
        ]);
    });

    test("an out-of-range numeric entity is left as written instead of throwing", () => {
        // `String.fromCodePoint(1114112)` throws RangeError, which used to
        // propagate out of the whole check and record nothing at all.
        const feed = parseFeed(
            `<rss><channel><item><title>bad &#1114112; entity</title><guid>x1</guid></item></channel></rss>`
        );

        expect(feed.items).toHaveLength(1);
        expect(feed.items[0].title).toBe("bad &#1114112; entity");
    });

    test("a valid numeric entity still decodes", () => {
        const feed = parseFeed(
            `<rss><channel><item><title>caf&#233; &#x2014; open</title><guid>x2</guid></item></channel></rss>`
        );

        expect(feed.items[0].title).toBe("café — open");
    });

    test("filterItems matches title or summary, case-insensitive", () => {
        const items = parseFeed(RSS).items;

        expect(filterItems(items, ["ios"]).map((item) => item.guid)).toEqual(["INCc33a8af"]);
        expect(filterItems(items, ["severity"]).map((item) => item.guid)).toEqual(["INCc33a8af"]);
        expect(filterItems(items, undefined)).toHaveLength(2);
    });

    test("a feed with no item tag keeps its whole document, last byte included", () => {
        // `xml.search(...)` answers -1 with no <item>, and -1 is truthy, so the
        // old `|| xml.length` fallback never fired and the head was
        // xml.slice(0, -1). A body cut by a proxy right after the channel title
        // loses the `>` of `</title>`, and the title stops being readable.
        const feed = parseFeed(`<rss><channel><title>All quiet</title>`);

        expect(feed.title).toBe("All quiet");
        expect(feed.items).toEqual([]);
    });

    test("a document that starts at the first item has no channel title to read", () => {
        // The other half of the same expression: search answers 0 here, and
        // `0 || xml.length` widened the head to the whole document, so the
        // FIRST ITEM's title was reported as the name of the feed.
        const feed = parseFeed(`<item><title>Item one</title><guid>g1</guid></item>`);

        expect(feed.title).toBeNull();
        expect(feed.items.map((entry) => entry.title)).toEqual(["Item one"]);
    });
});

describe("checkRss", () => {
    test("a non-ok response cancels the body instead of leaking a pooled socket", async () => {
        // The scheduler polls forever; an unread body holds its socket out of
        // the fetch pool until GC, one per watcher per interval.
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("rate limited"));
            },
            cancel() {
                cancelled = true;
            },
        });
        const realFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(
            async () => new Response(body, { status: 429, statusText: "Too Many Requests" }),
            {
                preconnect: realFetch.preconnect,
            }
        );

        try {
            const result = await checkRss({ target: "https://a.dev/rss", config: {}, timeoutMs: 1_000 });

            expect(result.status).toBe("down");
            expect(result.httpStatus).toBe(429);
            expect(cancelled).toBe(true);
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});
