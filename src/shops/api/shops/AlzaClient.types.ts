// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/alza/main.js

export interface AlzaPageData {
    id: string;
    name: string;
    url: string;
    price: {
        current: number;
        original?: number;
        currency: string;
    };
    availability?: string;
    imageUrl?: string;
    ean?: string;
    categoryPath?: string[];
    brand?: string;
}

export interface AlzaListingEntry {
    id: string;
    name: string;
    url: string;
    imageUrl?: string;
    currentPrice?: number;
    originalPrice?: number;
    availability?: string;
}

export interface AlzaCategoryListing {
    categoryId: string;
    categoryName: string;
    items: AlzaListingEntry[];
    hasMore: boolean;
    page: number;
}
