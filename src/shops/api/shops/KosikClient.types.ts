// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/kosik-daily/main.js

export interface KosikRawCategory {
    id: number;
    name: string;
    url: string;
    image?: string;
    vendorId?: number;
    subcategories?: KosikRawCategory[];
    subCategories?: KosikRawCategory[];
}

export interface KosikMenuMainResponse {
    categories?: KosikRawCategory[];
    children?: KosikRawCategory[];
}

export interface KosikBrand {
    id: number;
    name: string;
    url?: string;
}

export interface KosikRawProductItem {
    id: number;
    name: string;
    cleanName?: string;
    brand?: KosikBrand | string | null;
    url: string;
    price: number;
    recommendedPrice?: number;
    percentageDiscount?: number;
    isSale?: boolean;
    image?: string;
    firstOrderDay?: string | null;
    pricePerUnit?: { price?: number; unit?: string };
    productQuantity?: { value?: number; unit?: string; prefix?: string };
    ean?: string;
}

export interface KosikListingResponse {
    title?: string;
    breadcrumbs?: Array<{ name: string }>;
    products?: { items: KosikRawProductItem[] };
    more?: string | null;
    totalCount?: number;
    showProductsCount?: number;
}
