// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/albert/main.js

export interface AlbertCategoryInfo {
    categoryCode: string;
    categoryName: string;
}

export interface AlbertCategoryTreeEntry {
    categoryCode: string;
    categoryName: string;
    categoriesInfo?: AlbertCategoryInfo[];
}

export interface AlbertNavigationResponse {
    data?: {
        leftHandNavigationBar?: {
            categoryTreeList?: AlbertCategoryTreeEntry[];
        };
    };
    errors?: Array<{ message: string; reasonCode?: string }>;
}

export interface AlbertProductImage {
    url: string;
}

export interface AlbertProductPrice {
    value?: number;
    discountedPriceFormatted?: string | null;
    unit?: string;
}

export interface AlbertRawProduct {
    code: string;
    url: string;
    name: string;
    images?: AlbertProductImage[];
    price?: AlbertProductPrice;
    stock?: { inStock?: boolean };
}

export interface AlbertCategoryProductSearchResponse {
    data?: {
        categoryProductSearch?: {
            products?: AlbertRawProduct[];
            categoryBreadcrumbs?: Array<{ name: string }>;
            pagination?: { totalPages?: number; currentPage?: number };
        };
    };
    errors?: Array<{ message: string; reasonCode?: string }>;
}
