// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/drmax-daily/main.js

export interface DrmaxParsedTile {
    itemId: string | null;
    itemUrl: string;
    itemName: string;
    shortDesc: string | null;
    imageUrl: string | null;
    currentPrice: number | null;
    originalPrice: number | null;
    inStock: boolean;
}

export interface DrmaxJsonLdProduct {
    "@type"?: string;
    name?: string;
    image?: string | string[];
    description?: string;
    offers?: {
        price?: number | string;
        priceCurrency?: string;
        availability?: string;
    };
    gtin13?: string;
    sku?: string;
}

export const DRMAX_BASE_URL = "https://www.drmax.cz";
export const DRMAX_SITEMAP_URL = "https://backend.drmax.cz/media/sitemap/kategorie.xml";
export const DRMAX_BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
