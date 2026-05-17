// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/benu-daily/main.js

export interface BenuListingTile {
    itemId: string | null;
    itemUrl: string;
    itemName: string;
    imageUrl: string | null;
    currentPrice: number | null;
    originalPrice: number | null;
    inStock: boolean;
}

/** Single Schema.org Offer entry. */
export interface BenuOffer {
    price?: number | string;
    priceCurrency?: string;
}

/** JSON-LD richSnippet inside `#snippet-productRichSnippet-richSnippet`. */
export interface BenuRichSnippet {
    "@type"?: string;
    identifier?: string;
    name?: string;
    url?: string;
    image?: string;
    /** Schema.org allows offers to be a single Offer or an array of Offers. */
    offers?: BenuOffer | BenuOffer[];
}

/** Response from `/api/base/v1/products/{internalId}`. */
export interface BenuApiProduct {
    data?: {
        attributes?: {
            price?: {
                rrpPrice?: number | null;
                currentPrice?: number | null;
            };
        };
    };
}

export const BENU_BASE_URL = "https://www.benu.cz";
export const BENU_API_PRODUCT_REGEX = /api\/base\/v1\/products\/(\d+)/;
export const BENU_BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
