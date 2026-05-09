import { gunzipSync } from "node:zlib";
import logger from "@app/logger";
import { parseSitemap } from "@crawlee/utils";
import { parseHTML } from "linkedom";

const log = logger.child({ component: "sitemap-fetcher" });

const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export interface SitemapFetchOptions {
    /** Stop after collecting at least this many product URLs (loose cap). */
    maxUrls?: number;
    /** Stop after this many recursion depth levels through sitemap-index. */
    maxDepth?: number;
    /** AbortSignal for cancellation. */
    signal?: AbortSignal;
    /** UA string to send when fetching sitemaps (some shops 403 default UAs). */
    userAgent?: string;
    /** Filter applied to each child sitemap before recursion (e.g., only product shards). */
    childFilter?: (childUrl: string) => boolean;
    /** Filter applied to each leaf URL before yielding it. */
    urlFilter?: (url: string) => boolean;
    /** Verbose progress callback for long sitemap walks. */
    onProgress?: (event: SitemapFetchProgress) => void;
}

export interface SitemapFetchProgress {
    fetched: number;
    discoveredUrls: number;
    currentSitemap: string;
}

/**
 * Walk a sitemap tree and yield every leaf product URL.
 *
 * Crawlee's `Sitemap.load()` would do this in one line, but its bundled
 * `got-scraping` HTTP layer trips on Rohlik's HTTP/2 ALPN response (the
 * "Requested origin … does not match server …:443" failure). We therefore
 * fetch the XML/gzip bodies via native `fetch` and feed the raw content to
 * crawlee's `parseSitemap` for the actual URL extraction. That keeps us on
 * the project's standard HTTP stack while reusing crawlee's tested parser
 * (handles `<urlset>`, `<sitemapindex>`, and namespace variations).
 */
export async function* walkSitemap(
    rootUrl: string,
    opts: SitemapFetchOptions = {}
): AsyncGenerator<string, void, void> {
    const ua = opts.userAgent ?? DEFAULT_USER_AGENT;
    const maxDepth = opts.maxDepth ?? 4;
    const seen = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: rootUrl, depth: 0 }];
    let fetched = 0;
    let discovered = 0;

    while (queue.length > 0) {
        opts.signal?.throwIfAborted();
        const next = queue.shift();
        if (next === undefined) {
            break;
        }

        if (seen.has(next.url)) {
            continue;
        }

        seen.add(next.url);

        if (next.depth > maxDepth) {
            log.warn({ url: next.url, depth: next.depth }, "sitemap depth cap reached");
            continue;
        }

        const xml = await fetchSitemapBody(next.url, ua, opts.signal);
        fetched++;
        opts.onProgress?.({ fetched, discoveredUrls: discovered, currentSitemap: next.url });

        if (xml === null) {
            continue;
        }

        // crawlee's `parseSitemap` is happy parsing `<urlset>` content from a
        // raw string, but for `<sitemapindex>` it follows each child via its
        // bundled `got-scraping` HTTP layer — which fails on Czech eshop CDNs
        // (e.g. Rohlik returns "Requested origin … does not match server …:443").
        // To stay on the project's standard `fetch` we split the cases: parse
        // the index ourselves with linkedom and queue children, then defer to
        // crawlee for the leaf-URL extraction inside each `<urlset>` shard.
        if (isSitemapIndex(xml)) {
            for (const childUrl of extractChildSitemapLocs(xml)) {
                if (seen.has(childUrl)) {
                    continue;
                }

                if (!opts.childFilter || opts.childFilter(childUrl)) {
                    queue.push({ url: childUrl, depth: next.depth + 1 });
                }
            }

            continue;
        }

        for await (const item of parseSitemap([{ type: "raw", content: xml }])) {
            opts.signal?.throwIfAborted();

            // Defensive: occasionally a crawler ships URLs that look like
            // additional sitemaps inside a urlset. Re-queue rather than yield.
            if (looksLikeChildSitemap(item.loc)) {
                if (!opts.childFilter || opts.childFilter(item.loc)) {
                    queue.push({ url: item.loc, depth: next.depth + 1 });
                }

                continue;
            }

            if (opts.urlFilter && !opts.urlFilter(item.loc)) {
                continue;
            }

            discovered++;
            yield item.loc;

            if (opts.maxUrls !== undefined && discovered >= opts.maxUrls) {
                return;
            }
        }
    }
}

function isSitemapIndex(xml: string): boolean {
    // Cheap pre-parse sniff — sitemap-indexes always include the
    // `<sitemapindex` root tag. Avoids parsing a 6 MB urlset twice.
    return /<sitemapindex[\s>]/i.test(xml);
}

function extractChildSitemapLocs(xml: string): string[] {
    const { document } = parseHTML(xml);
    const out: string[] = [];
    for (const loc of Array.from(document.querySelectorAll("sitemap > loc, sitemapindex > sitemap > loc"))) {
        const text = loc.textContent?.trim();
        if (text) {
            out.push(text);
        }
    }

    return out;
}

async function fetchSitemapBody(
    url: string,
    userAgent: string,
    signal: AbortSignal | undefined
): Promise<string | null> {
    try {
        const res = await fetch(url, {
            headers: { "user-agent": userAgent, accept: "application/xml,text/xml,*/*" },
            signal,
            redirect: "follow",
        });

        if (!res.ok) {
            log.warn({ url, status: res.status }, "sitemap fetch non-200, skipping");
            return null;
        }

        // Some servers send `application/gzip` even when we asked for xml,
        // and others (lidl) explicitly serve `.xml.gz` URLs. Decompress both
        // ways: explicit URL extension and content-type sniff.
        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        const looksGz =
            url.endsWith(".gz") || contentType.includes("gzip") || contentType.includes("application/x-gzip");

        if (looksGz) {
            const buf = Buffer.from(await res.arrayBuffer());
            return gunzipSync(buf).toString("utf8");
        }

        return await res.text();
    } catch (err) {
        if ((err as Error).name === "AbortError") {
            throw err;
        }

        log.warn({ url, err }, "sitemap fetch threw, skipping");
        return null;
    }
}

function looksLikeChildSitemap(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith(".xml") || lower.endsWith(".xml.gz") || /\/sitemap[^/]*$/.test(lower);
}
