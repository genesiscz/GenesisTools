// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/kaufland-daily/main.js

export interface KauflandJsonLdProduct {
    "@type": "Product";
    name: string;
    sku: string | number;
    image: string | string[];
    offers: {
        url: string;
        availability: string;
        price: string | number;
        priceCurrency?: string;
    };
}

export interface KauflandParsedProduct {
    itemId: string;
    itemUrl: string;
    itemName: string;
    img?: string;
    inStock: boolean;
    currentPrice: number;
    originalPrice?: number;
    discounted: boolean;
    categoryPath: string[];
}
