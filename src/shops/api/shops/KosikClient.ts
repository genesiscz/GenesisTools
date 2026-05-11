// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/kosik-daily/main.js

import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import type {
    KosikListingResponse,
    KosikMenuMainResponse,
    KosikProductDetailResponse,
    KosikRawCategory,
    KosikRawProductItem,
} from "@app/shops/api/shops/KosikClient.types";

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
        const numericId = extractNumericId(input.url, input.slug);
        if (numericId === null) {
            throw new Error(
                `KosikClient.getProduct: cannot extract numeric id from url=${input.url ?? "?"} slug=${input.slug ?? "?"}`
            );
        }

        await this.waitTurn();
        const detail = await this.get<KosikProductDetailResponse>(`/api/front/product/${numericId}`);
        const item = detail.product;
        if (!item) {
            throw new Error(`Kosik product ${numericId} returned no product field`);
        }

        const breadcrumbs = (detail.breadcrumbs ?? []).map((b) => b.name).join(" > ");
        return this.toRawProduct(item, breadcrumbs);
    }

    /**
     * Stream RawProducts for a list of product ids. Kosik has no native
     * bulk-by-id endpoint, so we fan out concurrent /api/front/product/<id>
     * calls (waitTurn() inside getProduct keeps us under the rate cap).
     * Yields products as each call resolves; tolerates per-id failures.
     */
    async *listByIds(
        ids: string[],
        opts: { signal?: AbortSignal; concurrency?: number } = {}
    ): AsyncIterable<RawProduct> {
        const concurrency = Math.max(1, opts.concurrency ?? 4);
        for (let i = 0; i < ids.length; i += concurrency) {
            opts.signal?.throwIfAborted();
            const slice = ids.slice(i, i + concurrency);
            const settled = await Promise.allSettled(slice.map((id) => this.getProduct({ slug: `p${id}` })));
            for (let j = 0; j < settled.length; j++) {
                const r = settled[j];
                if (r.status === "fulfilled") {
                    yield r.value;
                }
                // Per-id 404s and transient errors are dropped — caller can
                // diff seen-vs-discovered to find them later.
            }
        }
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("KosikClient.listCategory requires opts.category");
        }

        const seenSlugs = new Set<string>();
        const seenItemIds = new Set<number>();
        const queue: string[] = [opts.category];
        let yielded = 0;
        while (queue.length > 0) {
            opts.signal?.throwIfAborted();
            const slug = queue.shift();
            if (slug === undefined || seenSlugs.has(slug)) {
                continue;
            }

            seenSlugs.add(slug);

            for await (const result of this.fetchSlugItems(slug, opts.signal)) {
                if (result.kind === "subcategory") {
                    if (!seenSlugs.has(result.slug)) {
                        queue.push(result.slug);
                    }

                    continue;
                }

                if (seenItemIds.has(result.item.id)) {
                    continue;
                }

                seenItemIds.add(result.item.id);
                yield this.toRawProduct(result.item, result.breadcrumbs);
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }
        }
    }

    private async *fetchSlugItems(
        slug: string,
        signal: AbortSignal | undefined
    ): AsyncIterable<
        { kind: "item"; item: KosikRawProductItem; breadcrumbs: string } | { kind: "subcategory"; slug: string }
    > {
        let nextUrl: string | null = buildListingPath(slug);
        const seenUrls = new Set<string>();
        let emittedSubs = false;
        while (nextUrl !== null) {
            signal?.throwIfAborted();
            if (seenUrls.has(nextUrl)) {
                return;
            }

            seenUrls.add(nextUrl);
            await this.waitTurn();
            const page: KosikListingResponse = await this.get<KosikListingResponse>(nextUrl, { signal });
            const breadcrumbs = breadcrumbsString(page);
            if (!emittedSubs) {
                emittedSubs = true;
                for (const sub of page.subCategories ?? []) {
                    yield { kind: "subcategory", slug: urlToSlug(sub.url) };
                }
            }

            const items = page.products?.items ?? [];
            for (const item of items) {
                yield { kind: "item", item, breadcrumbs };
            }

            if (typeof page.more === "string" && page.more.length > 0) {
                nextUrl = page.more;
                continue;
            }

            return;
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
        const brandName = item.brand && typeof item.brand === "object" ? item.brand.name : (item.brand ?? undefined);
        return {
            shopOrigin: KOSIK_ORIGIN,
            slug,
            itemId: String(item.id),
            url,
            name: item.name,
            brand: brandName,
            imageUrl: normalizeKosikImage(item.image),
            categoryPath: categoryPath ? categoryPath.split(" > ") : undefined,
            // Kosik exposes pack size as `productQuantity: {value, unit}`;
            // pass both through so the matcher's signature step (Layer 2a)
            // can fire on cross-shop comparisons.
            unit: item.productQuantity?.unit,
            unitAmount: item.productQuantity?.value,
            currentPrice: item.price,
            originalPrice,
            // `firstOrderDay` is the next available delivery date. When it's
            // in the past (or absent), the item is in stock; only treat a future
            // date as out-of-stock (preorder).
            inStock: !item.firstOrderDay || new Date(item.firstOrderDay) <= new Date(),
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

const KOSIK_THUMB_SIZE = "200x200";

export function normalizeKosikImage(image: string | null | undefined): string | undefined {
    if (!image) {
        return undefined;
    }

    return image.replace("WIDTHxHEIGHT", KOSIK_THUMB_SIZE);
}

function buildListingPath(slug: string): string {
    const params = new URLSearchParams({ slug, limit: String(DEFAULT_LIMIT) });
    return `/api/front/page/products?${params.toString()}`;
}

function extractNumericId(url: string | undefined, slug: string | undefined): number | null {
    const candidate = slug ?? url ?? "";
    const match = candidate.match(/p(\d+)(?:-|$)/);
    if (!match) {
        return null;
    }

    const n = Number.parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
}

function breadcrumbsString(listing: KosikListingResponse): string {
    return listing.breadcrumbs?.map((b) => b.name).join(" > ") ?? listing.title ?? "";
}
