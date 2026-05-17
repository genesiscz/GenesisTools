// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/lidl-daily/main.js

export interface LidlPriceDiscount {
    showDiscount?: boolean;
    deletedPrice?: number;
}

export interface LidlGridboxData {
    fullTitle: string;
    canonicalPath: string;
    image?: string;
    price?: {
        price?: number;
        discount?: LidlPriceDiscount;
    };
    stockAvailability?: { onlineAvailable?: boolean };
    category?: string;
}

export interface LidlApiItem {
    code: string;
    gridbox?: { data?: LidlGridboxData };
}

export interface LidlApiCategoryResponse {
    items?: LidlApiItem[];
    numFound?: number;
}

/** Discriminator for category traversal — `/h/<slug>/h<id>` vs `/c/<slug>/s<id>` URLs. */
export type LidlCategoryType = "hub" | "category" | "unknown";

export interface LidlCategoryNode {
    /** Path slug (e.g. "slevy" from `/c/slevy/s10076329`). */
    path: string;
    /** ID with prefix (`s` for category, `h` for hub). Used in API URL. */
    id: string;
    type: LidlCategoryType;
    url: string;
}
