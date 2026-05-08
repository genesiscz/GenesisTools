// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/dm-daily/main.js

import { ShopApiClient, type ShopApiClientConstructorConfig } from "../ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../ShopApiClient.types";
import type {
    DmCategoryResponse,
    DmNavigationNode,
    DmNavigationResponse,
    DmProductListingResponse,
    DmRawProduct,
} from "./DmClient.types";

const DM_ORIGIN = "dm.cz";
const STORE_ROOT = "https://www.dm.cz";
const CONTENT_BASE = "https://content.services.dmtech.com/rootpage-dm-shop-cs-cz";
const SEARCH_BASE = "https://product-search.services.dmtech.com/cz/search/static";
const PAGE_SIZE = 60;

export class DmClient extends ShopApiClient {
    readonly shopOrigin = DM_ORIGIN;
    readonly displayName = "dm.cz";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: true,
        search: false,
        botProtection: "none",
    };

    constructor(config: ShopApiClientConstructorConfig = {}) {
        super({
            baseUrl: STORE_ROOT,
            loggerContext: { provider: "dm" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 2,
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        throw new Error(
            `DmClient.getProduct: not implemented in Phase 2; use listCategory or tools shops get instead (input=${input.url ?? input.slug})`
        );
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("DmClient.listCategory requires opts.category (slug like 'dekorativni-kosmetika/oci/rasenky')");
        }

        await this.waitTurn();
        const meta = await this.get<DmCategoryResponse>(`${CONTENT_BASE}/${opts.category}/`, {
            signal: opts.signal,
        });
        const productQuery = extractProductQuery(meta);
        if (!productQuery) {
            return;
        }

        let yielded = 0;
        let page = 0;
        let totalPages = 1;
        while (page < totalPages) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const listing = await this.get<DmProductListingResponse>(SEARCH_BASE, {
                params: {
                    ...productQuery,
                    pageSize: PAGE_SIZE,
                    currentPage: page,
                    sort: "price_asc",
                    type: "search-static",
                },
                signal: opts.signal,
            });

            for (const product of listing.products ?? []) {
                yield this.toRawProduct(product, opts.category);
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }

            totalPages = listing.totalPages ?? 1;
            page++;
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const tree = await this.get<DmNavigationResponse>(`${CONTENT_BASE}/`, {
            params: { view: "navigation" },
        });
        const out: Category[] = [];
        flattenNavigation(tree.navigation, undefined, out);
        return out;
    }

    private toRawProduct(p: DmRawProduct, categoryPath: string): RawProduct {
        const td = p.tileData ?? {};
        const titlePieces: string[] = [];
        if (p.brandName) {
            titlePieces.push(p.brandName);
        }

        if (td.title?.tileHeadline) {
            titlePieces.push(td.title.tileHeadline);
        }

        const name = titlePieces.join(" ").trim() || td.title?.tileHeadlineLong || String(p.gtin ?? p.dan ?? "");
        const slug = (td.self ?? "").replace(/^\//, "") || String(p.gtin ?? p.dan ?? "");
        const url = td.self ? new URL(td.self, STORE_ROOT).href : STORE_ROOT;
        const itemId = String(p.dan ?? p.gtin ?? "");
        const ean = p.gtin !== undefined ? String(p.gtin) : undefined;

        return {
            shopOrigin: DM_ORIGIN,
            slug,
            itemId,
            url,
            name,
            brand: p.brandName,
            ean,
            imageUrl: td.images?.[0]?.tileSrc ?? td.images?.[0]?.src,
            categoryPath: categoryPath.split("/").filter((s) => s.length > 0),
            currentPrice: parsePrice(td.price?.price?.current?.value),
            originalPrice: parsePrice(td.price?.price?.previous?.value),
            inStock: undefined,
            observedAt: new Date(),
            raw: p,
        };
    }
}

function extractProductQuery(meta: DmCategoryResponse): Record<string, string | number> | undefined {
    for (const entry of meta.mainData ?? []) {
        const q = entry.query;
        if (q && typeof q.filters === "string" && q.filters.length > 0) {
            return {
                queryTerms: q.queryTerms ?? "",
                filters: q.filters,
            };
        }
    }

    return undefined;
}

function flattenNavigation(node: DmNavigationNode, parent: string | undefined, out: Category[]): void {
    if (node.link && node.title) {
        const id = node.link.replace(/^\//, "");
        out.push({
            id,
            name: node.title,
            parentId: parent,
            slug: id,
            url: `${STORE_ROOT}${node.link.startsWith("/") ? "" : "/"}${node.link}`,
        });
        for (const child of node.children ?? []) {
            flattenNavigation(child, id, out);
        }

        return;
    }

    for (const child of node.children ?? []) {
        flattenNavigation(child, parent, out);
    }
}

function parsePrice(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value
        .replace(/[^\d,.\s ]/g, "")
        .replace(/[\s ]+/g, "")
        .replace(/,/g, ".");
    const n = Number.parseFloat(normalized);
    return Number.isFinite(n) ? n : undefined;
}
