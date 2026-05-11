// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/billa/main.js

import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import type { BillaCategoryListingResponse, BillaRawProduct } from "@app/shops/api/shops/BillaClient.types";

const BILLA_ORIGIN = "billa.cz";
const STORE_ROOT = "https://shop.billa.cz";
const PAGE_SIZE = 100;

const DEFAULT_CATEGORIES: Category[] = [
    { id: "pekarna", name: "Pekárna" },
    { id: "mleko-jogurty-syry", name: "Mléko, jogurty, sýry" },
    { id: "maso-uzeniny", name: "Maso a uzeniny" },
    { id: "ovoce-zelenina", name: "Ovoce a zelenina" },
    { id: "napoje", name: "Nápoje" },
    { id: "drogerie", name: "Drogerie" },
];

export class BillaClient extends ShopApiClient {
    readonly shopOrigin = BILLA_ORIGIN;
    readonly displayName = "Billa.cz";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: false,
        search: false,
        botProtection: "none",
    };

    constructor(config: ShopApiClientConstructorConfig = {}) {
        super({
            baseUrl: STORE_ROOT,
            loggerContext: { provider: "billa" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 2,
            ...config,
        });
    }

    /**
     * NOT IMPLEMENTED in Phase 2.
     *
     * Billa's product-discovery API exposes detail info as part of the listing
     * response (see {@link BillaCategoryListingResponse} → `BillaRawProduct`),
     * so most callers can use the `raw` payload from `listCategory()` directly.
     * A dedicated endpoint for single-product lookup will land alongside the
     * Phase 3 detail-augmentation work; until then this method intentionally
     * throws to surface accidental live-detail traffic against Billa.
     *
     * The class still advertises `capabilities.live = true` because listing IS
     * a live source; gate live-detail flows on `capabilities.detail` (added in
     * Phase 3) rather than `live`.
     */
    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        throw new Error(`BillaClient.getProduct: not implemented in Phase 2 (input=${input.url ?? input.slug})`);
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("BillaClient.listCategory requires opts.category");
        }

        let yielded = 0;
        let page = 0;
        while (true) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const listing = await this.get<BillaCategoryListingResponse>(
                `/api/product-discovery/categories/${opts.category}/products`,
                { params: { pageSize: PAGE_SIZE, page }, signal: opts.signal }
            );
            const products = listing.products ?? [];
            if (products.length === 0) {
                return;
            }

            for (const product of products) {
                yield this.toRawProduct(product);
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }

            const total = listing.total ?? 0;
            const count = listing.count ?? products.length;
            // Defensive: when `total` is omitted by the API, only stop if the
            // current page is short. When `total` IS present, also stop once
            // we've covered it. Avoids the original bug where `total ?? 0`
            // halted pagination after page 0.
            if (count < PAGE_SIZE || (total > 0 && (page + 1) * PAGE_SIZE >= total)) {
                return;
            }

            page++;
        }
    }

    async listCategories(): Promise<Category[]> {
        return DEFAULT_CATEGORIES;
    }

    private toRawProduct(p: BillaRawProduct): RawProduct {
        const slug = p.slug;
        const itemId = p.sku.replace(/-/g, "");
        const url = `${STORE_ROOT}/produkty/${slug}`;
        const breadcrumbs = (p.parentCategories ?? []).map((c) => c.name);
        const currentPrice = toCZK(p.price?.regular?.value);
        const discountedPrice = toCZK(p.price?.discounted?.value);
        return {
            shopOrigin: BILLA_ORIGIN,
            slug,
            itemId,
            url,
            name: p.name,
            imageUrl: p.images?.[0],
            categoryPath: breadcrumbs.length > 0 ? breadcrumbs : undefined,
            currentPrice: discountedPrice ?? currentPrice,
            originalPrice: discountedPrice !== undefined ? currentPrice : undefined,
            inStock: undefined,
            observedAt: new Date(),
            raw: p,
        };
    }
}

function toCZK(value: number | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    return Math.round(value) / 100;
}
