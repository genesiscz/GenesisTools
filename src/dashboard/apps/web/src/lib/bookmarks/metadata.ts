export interface UrlMetadata {
    title: string;
    description: string;
    faviconUrl: string;
}

/**
 * Decode common named and numeric HTML entities.
 * Handles: &amp; &lt; &gt; &quot; &#39; &#NNN; &#xNN;
 * Pure string transform — no DOM, no cheerio.
 */
function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
}

/**
 * Resolve a potentially relative href against the page's origin/path.
 * Returns null if the href is not usable.
 */
function resolveHref(href: string, pageUrl: string): string | null {
    try {
        return new URL(href, pageUrl).href;
    } catch {
        return null;
    }
}

/**
 * Extract metadata from raw HTML without any DOM parser.
 * Uses case-insensitive regex — good enough for <head> content.
 */
export function extractHtmlMetadata(html: string, pageUrl: string): UrlMetadata {
    // --- Title: og:title wins over <title> ---
    let title = "";
    const ogTitleMatch =
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*?)["']/i) ??
        html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:title["']/i);
    if (ogTitleMatch) {
        title = decodeHtmlEntities(ogTitleMatch[1].trim());
    } else {
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (titleMatch) {
            title = decodeHtmlEntities(titleMatch[1].trim());
        }
    }

    // --- Description: og:description wins over meta description ---
    let description = "";
    const ogDescMatch =
        html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*?)["']/i) ??
        html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:description["']/i);
    if (ogDescMatch) {
        description = decodeHtmlEntities(ogDescMatch[1].trim());
    } else {
        const metaDescMatch =
            html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*?)["']/i) ??
            html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']description["']/i);
        if (metaDescMatch) {
            description = decodeHtmlEntities(metaDescMatch[1].trim());
        }
    }

    // --- Favicon: <link rel="icon"|"shortcut icon"> or fallback /favicon.ico ---
    let faviconUrl = "";
    const faviconMatch =
        html.match(/<link[^>]+rel=["'](?:shortcut icon|icon)["'][^>]+href=["']([^"']+)["']/i) ??
        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut icon|icon)["']/i);
    if (faviconMatch) {
        const resolved = resolveHref(faviconMatch[1].trim(), pageUrl);
        faviconUrl = resolved ?? "";
    }

    if (!faviconUrl) {
        try {
            const origin = new URL(pageUrl).origin;
            faviconUrl = `${origin}/favicon.ico`;
        } catch {
            faviconUrl = "";
        }
    }

    return { title, description, faviconUrl };
}
