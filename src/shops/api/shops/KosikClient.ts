// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/kosik-daily/main.js

import { ShopApiClient, type ShopApiClientConstructorConfig } from "../ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../ShopApiClient.types";
import type {
    KosikListingResponse,
    KosikMenuMainResponse,
    KosikRawCategory,
    KosikRawProductItem,
} from "./KosikClient.types";

const KOSIK_ORIGIN = "kosik.cz";
const ROOT = "https://www.kosik.cz";
const DEFAULT_LIMIT = 30;

export class KosikClient extends ShopApiClient {
    readonly shopOrigin = KOSIK_ORIGIN;
    readonly displayName = "Košík.cz";
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
            baseUrl: ROOT,
            loggerContext: { provider: "kosik" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 2,
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        const slug = input.slug ?? this.parseUrl(input.url ?? "").slug;
        await this.waitTurn();
        const listing = await this.get<KosikListingResponse>("/api/front/page/products", {
            params: { slug, limit: 1 },
        });
        const item = listing.products?.items?.[0];
        if (!item) {
            throw new Error(`Kosik product ${slug} not found in listing`);
        }

        return this.toRawProduct(item, breadcrumbsString(listing));
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("KosikClient.listCategory requires opts.category");
        }

        let yielded = 0;
        let offset = 0;
        let totalCount: number | undefined;

        while (true) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const params: Record<string, string | number> = {
                slug: opts.category,
                limit: DEFAULT_LIMIT,
            };
            if (offset > 0) {
                params.offset = offset;
            }

            const page = await this.get<KosikListingResponse>("/api/front/page/products", {
                params,
                signal: opts.signal,
            });
            const breadcrumbs = breadcrumbsString(page);
            const items = page.products?.items ?? [];
            if (items.length === 0) {
                return;
            }

            for (const item of items) {
                yield this.toRawProduct(item, breadcrumbs);
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }

            if (totalCount === undefined) {
                totalCount = page.totalCount;
            }

            offset += items.length;
            if (totalCount === undefined || offset >= totalCount) {
                return;
            }
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const menu = await this.get<KosikMenuMainResponse>("/api/front/menu/main");
        const roots = menu.categories ?? menu.children ?? [];
        return Array.from(flattenCategories(roots));
    }

    private toRawProduct(item: KosikRawProductItem, categoryPath: string): RawProduct {
        const url = new URL(item.url, ROOT).href;
        const slug = urlToSlug(item.url);
        const originalPrice =
            item.recommendedPrice !== undefined && item.recommendedPrice !== item.price
                ? item.recommendedPrice
                : undefined;
        const brandName =
            item.brand && typeof item.brand === "object" ? item.brand.name : (item.brand ?? undefined);
        return {
            shopOrigin: KOSIK_ORIGIN,
            slug,
            itemId: String(item.id),
            url,
            name: item.name,
            brand: brandName,
            imageUrl: item.image,
            categoryPath: categoryPath ? categoryPath.split(" > ") : undefined,
            unit: undefined,
            unitAmount: item.productQuantity?.value,
            currentPrice: item.price,
            originalPrice,
            inStock: !item.firstOrderDay,
            ean: item.ean,
            observedAt: new Date(),
            raw: item,
        };
    }
}

function* flattenCategories(nodes: KosikRawCategory[], parent?: string): Generator<Category> {
    for (const node of nodes) {
        const id = urlToSlug(node.url);
        yield {
            id,
            name: node.name,
            parentId: parent,
            slug: id,
            url: `${ROOT}${node.url.startsWith("/") ? "" : "/"}${node.url}`,
        };
        const subs = node.subcategories ?? node.subCategories;
        if (subs && subs.length > 0) {
            yield* flattenCategories(subs, id);
        }
    }
}

function urlToSlug(url: string): string {
    return url.startsWith("/") ? url.slice(1) : url;
}

function breadcrumbsString(listing: KosikListingResponse): string {
    return listing.breadcrumbs?.map((b) => b.name).join(" > ") ?? listing.title ?? "";
}
