// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/hornbach-daily/main.js

export const HORNBACH_SELECTORS = {
    TOP_CATEGORIES: '[data-testid="product-category"] h2 a',
    SUB_CATEGORIES: '[data-testid="categories-slider"] [data-testid="slider-card"] a',
    CATEGORY_NAME: '[data-testid="categories-slider"] [data-testid="slider-card"] a p',
    TOTAL_PRODUCTS_COUNT: '[data-testid="result-count"]',
    PRODUCT_CARD: '[data-testid="product-card"]',
    PRODUCT_TITLE: '[data-testid="product-title"]',
    PRODUCT_PRICE: '[data-testid="product-price"]',
    PRODUCT_OLD_PRICE: '[data-testid="product-old-price"]',
} as const;
