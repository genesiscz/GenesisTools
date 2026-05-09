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

export interface KosikListingProducts {
    items: KosikRawProductItem[];
    totalCount?: number;
    cursor?: string | null;
}

export interface KosikListingResponse {
    title?: string;
    breadcrumbs?: Array<{ name: string }>;
    products?: KosikListingProducts;
    /** Legacy field used by older actor builds; current API omits it. */
    more?: string | null;
    /** Subcategories of the current category — used by the actor's recursive traversal. */
    subCategories?: KosikRawCategory[];
    totalCount?: number;
    showProductsCount?: boolean | number;
}

/**
 * `/api/front/product/{numericId}` returns a product wrapped in `product` and
 * a parallel `breadcrumbs` array — distinct shape from the listing endpoint.
 */
export interface KosikProductDetailResponse {
    breadcrumbs?: Array<{ id?: number; name: string; url?: string }>;
    product?: KosikRawProductItem;
}
