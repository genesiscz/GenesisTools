/**
 * Per-shop sitemap configuration. Says where to start, which child sitemap
 * shards to recurse into (avoids walking brand/category sitemaps), and how
 * to derive the canonical product slug from a sitemap URL — letting us
 * de-duplicate against the existing `products.slug` column without a full
 * re-fetch of every URL.
 */

export interface SitemapStrategy {
    shopOrigin: string;
    rootSitemap: string;
    isProductChild: (childUrl: string) => boolean;
    isProductLeaf: (url: string) => boolean;
    productSlug: (url: string) => string | null;
    /**
     * Extract the id that the shop's `listByIds()` accepts. Often equal to
     * `productSlug` minus a prefix (kosik strips the `p`, lidl strips it,
     * rohlik passes through). Returning null skips the URL.
     */
    productId: (url: string) => string | null;
}

export const SITEMAP_STRATEGIES: Record<string, SitemapStrategy> = {
    "kosik.cz": {
        shopOrigin: "kosik.cz",
        rootSitemap: "https://www.kosik.cz/sitemap.xml",
        isProductChild: (u) => /\/products_\d+\.xml/i.test(u),
        isProductLeaf: (u) => /\/p\d+-/.test(u),
        productSlug: (u) => extractKosikSlug(u),
        productId: (u) => extractKosikId(u),
    },
    "rohlik.cz": {
        shopOrigin: "rohlik.cz",
        rootSitemap: "https://www.rohlik.cz/sitemap.xml",
        isProductChild: (u) => u.endsWith("sitemap_products.xml"),
        isProductLeaf: (u) => /\/\d+-[a-z0-9-]+/.test(u),
        productSlug: (u) => extractRohlikSlug(u),
        productId: (u) => extractRohlikSlug(u),
    },
    "lidl.cz": {
        shopOrigin: "lidl.cz",
        rootSitemap: "https://www.lidl.cz/static/sitemap.xml",
        // The product shard is `https://www.lidl.cz/p/export/CZ/cs/product_sitemap.xml.gz`.
        // We deliberately skip `pages_cs-CZ_cz.xml.gz` (CMS pages) and the
        // store-locator sitemap.
        isProductChild: (u) => u.includes("product_sitemap.xml"),
        isProductLeaf: (u) => /\/p\//.test(u),
        productSlug: (u) => extractLidlSlug(u),
        productId: (u) => extractLidlSlug(u),
    },
};

function extractKosikSlug(url: string): string | null {
    // Examples:
    //   https://www.kosik.cz/p708210-healthyco-krupavy-mandlovo-kokosovy-krem
    //   https://www.kosik.cz/p1000814672-cerstve-nakrajeno-bulka-losos-2x70g
    const match = url.match(/\/(p\d+-[^?#]+)/);
    return match ? match[1] : null;
}

function extractKosikId(url: string): string | null {
    // KosikClient.getProduct extracts the numeric id from `pNNN-…` and calls
    // /api/front/product/<id>. Strip the `p` prefix so listByIds() can
    // pass the raw id to that endpoint.
    const match = url.match(/\/p(\d+)-/);
    return match ? match[1] : null;
}

function extractRohlikSlug(url: string): string | null {
    // KosikRest-style id-prefixed slugs: /1296729-nivea-men-...
    // The persisted Rohlik slug is the leading numeric id (RohlikClient.ts:137).
    const match = url.match(/\/(\d+)-[^?#]+/);
    return match ? match[1] : null;
}

/**
 * Extract Lidl's persisted slug (bare numeric `item.code`) from a sitemap URL.
 *
 * Lidl product URLs look like:
 *   https://www.lidl.cz/p/livarno-elektricky-davkovac-mydla/p100396182
 *
 * `LidlClient` persists `slug = item.code` — a bare numeric (e.g. "100396182"),
 * NOT the URL-embedded "p100396182". We strip the leading `p` so the diff
 * against `products.slug` actually matches.
 *
 * Return safety: the regex requires `\d+` (one-or-more digits), so when it
 * matches, `match[1]` is guaranteed to be a non-empty digit string. Callers
 * may treat a non-null return as a usable id without further validation.
 */
function extractLidlSlug(url: string): string | null {
    const match = url.match(/\/p(\d+)(?:[?#]|$)/);
    return match ? match[1] : null;
}
