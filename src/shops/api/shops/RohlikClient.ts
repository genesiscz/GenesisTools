// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/rohlik-daily/main.js

import { ShopApiClient, type ShopApiClientConstructorConfig } from "../ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../ShopApiClient.types";
import type {
    RohlikCategoryCountResponse,
    RohlikCategoryProductsResponse,
    RohlikFlatNavigationResponse,
    RohlikProductPriceEntry,
    RohlikProductsBatchResponse,
    RohlikProductsPricesBatchResponse,
    RohlikRawCategory,
    RohlikRawProduct,
} from "./RohlikClient.types";

const PRODUCTS_PER_BATCH = 15;
const PRODUCTS_PER_PAGE = 100;
const ROHLIK_ORIGIN = "rohlik.cz";

export class RohlikClient extends ShopApiClient {
    readonly shopOrigin = ROHLIK_ORIGIN;
    readonly displayName = "Rohlík.cz";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: true,
        search: true,
        botProtection: "none",
    };

    constructor(config: ShopApiClientConstructorConfig = {}) {
        super({
            baseUrl: "https://www.rohlik.cz",
            loggerContext: { provider: "rohlik" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 4,
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        const slug = input.slug ?? this.parseUrl(input.url ?? "").slug;
        await this.waitTurn();

        const [productsResp, pricesResp] = await Promise.all([
            this.get<RohlikProductsBatchResponse>("/api/v1/products", {
                params: { products: [slug] },
            }),
            this.get<RohlikProductsPricesBatchResponse>("/api/v1/products/prices", {
                params: { products: [slug] },
            }),
        ]);

        const products = unwrapProducts(productsResp);
        if (products.length === 0) {
            throw new Error(`Rohlik product ${slug} returned empty response`);
        }

        const priceMap = indexPrices(pricesResp);
        const target = products[0];
        const targetId = target.productId ?? target.id;
        return this.toRawProduct(target, targetId !== undefined ? priceMap.get(targetId) : undefined);
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("RohlikClient.listCategory requires opts.category");
        }

        await this.waitTurn();
        const count = await this.get<RohlikCategoryCountResponse>(
            `/api/v1/categories/normal/${opts.category}/products/count`,
            { signal: opts.signal }
        );
        const totalPages = Math.ceil(count.results / PRODUCTS_PER_PAGE);
        const maxPages =
            opts.limit !== undefined ? Math.min(totalPages, Math.ceil(opts.limit / PRODUCTS_PER_PAGE)) : totalPages;

        let yielded = 0;
        for (let page = 0; page < maxPages; page++) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const listing = await this.get<RohlikCategoryProductsResponse>(
                `/api/v1/categories/normal/${opts.category}/products`,
                { params: { page }, signal: opts.signal }
            );
            const ids = listing.productIds ?? [];
            for (let i = 0; i < ids.length; i += PRODUCTS_PER_BATCH) {
                opts.signal?.throwIfAborted();
                const batchIds = ids.slice(i, i + PRODUCTS_PER_BATCH);
                await this.waitTurn();
                const [productsResp, pricesResp] = await Promise.all([
                    this.get<RohlikProductsBatchResponse>("/api/v1/products", {
                        params: { products: batchIds.map(String) },
                        signal: opts.signal,
                    }),
                    this.get<RohlikProductsPricesBatchResponse>("/api/v1/products/prices", {
                        params: { products: batchIds.map(String) },
                        signal: opts.signal,
                    }),
                ]);
                const products = unwrapProducts(productsResp);
                const priceMap = indexPrices(pricesResp);

                for (const product of products) {
                    const id = product.productId ?? product.id;
                    yield this.toRawProduct(product, id !== undefined ? priceMap.get(id) : undefined);
                    yielded++;
                    if (opts.limit !== undefined && yielded >= opts.limit) {
                        return;
                    }
                }
            }
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const tree = await this.get<RohlikFlatNavigationResponse>(
            "/services/frontend-service/renderer/navigation/flat.json"
        );
        const out: Category[] = [];
        for (const [id, raw] of Object.entries(tree.navigation)) {
            out.push(toCategory(id, raw));
        }

        return out;
    }

    private toRawProduct(product: RohlikRawProduct, priceEntry?: RohlikProductPriceEntry): RawProduct {
        const id = product.productId ?? product.id;
        if (id === undefined) {
            throw new Error("Rohlik product has no id/productId");
        }

        const slug = String(id);
        const url = `https://www.rohlik.cz/${id}-${product.slug}`;

        let currentPrice = priceEntry?.price?.amount;
        let originalPrice: number | undefined;
        const sales = priceEntry?.sales ?? [];
        for (const sale of sales) {
            if (sale.type === "sale") {
                if (!sale.silent && currentPrice !== undefined) {
                    originalPrice = currentPrice;
                }

                if (sale.price?.amount !== undefined) {
                    currentPrice = sale.price.amount;
                }
            }
        }

        return {
            shopOrigin: ROHLIK_ORIGIN,
            slug,
            itemId: slug,
            url,
            name: product.name,
            brand: product.brand,
            ean: product.ean,
            imageUrl: product.images?.[0],
            currentPrice,
            originalPrice,
            inStock: product.inStock,
            observedAt: new Date(),
            raw: { product, price: priceEntry },
        };
    }
}

function unwrapProducts(resp: RohlikProductsBatchResponse): RohlikRawProduct[] {
    if (Array.isArray(resp)) {
        return resp;
    }

    return resp.data ?? [];
}

function indexPrices(prices: RohlikProductsPricesBatchResponse): Map<number, RohlikProductPriceEntry> {
    const map = new Map<number, RohlikProductPriceEntry>();
    for (const entry of prices) {
        map.set(entry.productId, entry);
    }

    return map;
}

function toCategory(id: string, raw: RohlikRawCategory): Category {
    return {
        id,
        name: raw.name,
        parentId: raw.parentId !== undefined ? String(raw.parentId) : undefined,
        url: raw.link,
    };
}
