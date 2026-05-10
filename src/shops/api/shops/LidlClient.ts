// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/lidl-daily/main.js

import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import type {
    LidlApiCategoryResponse,
    LidlApiItem,
    LidlCategoryNode,
    LidlCategoryType,
} from "@app/shops/api/shops/LidlClient.types";
import { SafeJSON } from "@app/utils/json";
import { parseHTML } from "linkedom";

const LIDL_ORIGIN = "lidl.cz";
const STORE_ROOT = "https://www.lidl.cz";
const HOME_URL = `${STORE_ROOT}/c/kategorie/s10004543`;
const FETCH_SIZE = 200;
const URL_RE = /\/(h|c)\/([^/]+)\/([hs]\d+)/;

export class LidlClient extends ShopApiClient {
    readonly shopOrigin = LIDL_ORIGIN;
    readonly displayName = "Lidl.cz";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: false,
        search: false,
        botProtection: "soft",
    };

    constructor(config: ShopApiClientConstructorConfig = {}) {
        super({
            baseUrl: STORE_ROOT,
            loggerContext: { provider: "lidl" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 1.5,
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string; signal?: AbortSignal }): Promise<RawProduct> {
        const url = input.url ?? (input.slug ? buildProductUrl(input.slug) : null);
        if (!url) {
            throw new Error("LidlClient.getProduct requires url or slug");
        }

        await this.waitTurn();
        const html = await this.getText(url, { signal: input.signal });
        const data = extractDatalayerProduct(html);
        if (!data) {
            throw new Error(`Lidl product page ${url}: unified_datalayer_product missing`);
        }

        return toRawProductFromDatalayer(data, url);
    }

    /**
     * Stream RawProducts for a list of product ids by scraping each
     * product's HTML page and parsing the embedded `unified_datalayer_product`
     * JSON blob — Lidl has no public per-product JSON endpoint.
     * Per-id failures are dropped (404s, rendering quirks).
     */
    async *listByIds(
        ids: string[],
        opts: { signal?: AbortSignal; concurrency?: number } = {}
    ): AsyncIterable<RawProduct> {
        const concurrency = Math.max(1, opts.concurrency ?? 4);
        for (let i = 0; i < ids.length; i += concurrency) {
            opts.signal?.throwIfAborted();
            const slice = ids.slice(i, i + concurrency);
            const settled = await Promise.allSettled(
                slice.map((id) => this.getProduct({ slug: id, signal: opts.signal }))
            );
            for (const r of settled) {
                if (r.status === "fulfilled") {
                    yield r.value;
                }
            }
        }
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("LidlClient.listCategory requires opts.category (path/id like 'slevy/s10076329')");
        }

        const node = parseCategorySpec(opts.category);
        if (node.type !== "category") {
            throw new Error(
                `LidlClient.listCategory only supports leaf '/c/.../s<id>' categories; got type=${node.type} for ${opts.category}`
            );
        }

        let yielded = 0;
        let offset = 0;
        while (true) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const listing = await this.get<LidlApiCategoryResponse>(`/q/api/category/${node.path}/${node.id}`, {
                params: {
                    offset,
                    fetchsize: FETCH_SIZE,
                    locale: "cs_CZ",
                    assortment: "CZ",
                    version: "2.1.0",
                },
                signal: opts.signal,
            });
            const items = listing.items ?? [];
            if (items.length === 0) {
                return;
            }

            for (const item of items) {
                const raw = this.toRawProduct(item);
                if (raw) {
                    yield raw;
                    yielded++;
                    if (opts.limit !== undefined && yielded >= opts.limit) {
                        return;
                    }
                }
            }

            offset += items.length;
            const numFound = listing.numFound ?? 0;
            if (offset >= numFound) {
                return;
            }
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const html = await this.getText(HOME_URL);
        const { document } = parseHTML(html);
        const out: Category[] = [];
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
            const href = a.getAttribute("href") ?? "";
            const m = URL_RE.exec(href);
            if (!m) {
                continue;
            }

            const [, kind, path, id] = m;
            const type: LidlCategoryType = kind === "c" ? "category" : kind === "h" ? "hub" : "unknown";
            out.push({
                id: `${path}/${id}`,
                name: (a.textContent ?? "").trim() || path,
                slug: path,
                url: new URL(href, STORE_ROOT).href,
                parentId: type === "hub" ? "hub" : undefined,
            });
        }

        return out;
    }

    private toRawProduct(item: LidlApiItem): RawProduct | undefined {
        const data = item.gridbox?.data;
        if (!data) {
            return undefined;
        }

        const url = new URL(data.canonicalPath, STORE_ROOT).href;
        const slug = item.code;
        const breadcrumbs = data.category ? data.category.split("/").filter((s) => s.length > 0) : undefined;
        const currentPrice = data.price?.price;
        const originalPrice = data.price?.discount?.deletedPrice;
        return {
            shopOrigin: LIDL_ORIGIN,
            slug,
            itemId: item.code,
            url,
            name: data.fullTitle,
            imageUrl: data.image,
            categoryPath: breadcrumbs && breadcrumbs.length > 0 ? breadcrumbs : undefined,
            currentPrice,
            originalPrice: originalPrice !== undefined && originalPrice !== currentPrice ? originalPrice : undefined,
            inStock: data.stockAvailability?.onlineAvailable,
            observedAt: new Date(),
            raw: item,
        };
    }
}

interface LidlDatalayerProduct {
    id: string | number;
    name?: string;
    brand?: string;
    price?: number;
    netPrice?: number | null;
    currency?: string;
    availability?: string;
    categoryPrimary?: string;
    type?: string;
    sapId?: string | null;
    parentId?: string | null;
    variantId?: string | null;
    variantGroupId?: string | null;
}

const DATALAYER_RE = /var\s+unified_datalayer_product\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/;

function extractDatalayerProduct(html: string): LidlDatalayerProduct | null {
    const m = html.match(DATALAYER_RE);
    if (!m) {
        return null;
    }

    try {
        return SafeJSON.parse(m[1]) as LidlDatalayerProduct;
    } catch {
        return null;
    }
}

function buildProductUrl(slug: string): string {
    // The slug we feed in is just the numeric id (e.g. "100396182"). Lidl
    // accepts `/p/_/p<id>` as a shorter canonical URL that 301s to the
    // marketing-slug variant.
    return `${STORE_ROOT}/p/_/p${slug}`;
}

function toRawProductFromDatalayer(data: LidlDatalayerProduct, url: string): RawProduct {
    const slug = String(data.id);
    const breadcrumbs = data.categoryPrimary?.split("/").filter((s) => s.length > 0);
    return {
        shopOrigin: LIDL_ORIGIN,
        slug,
        itemId: slug,
        url,
        name: data.name ?? slug,
        brand: data.brand ?? undefined,
        currentPrice: typeof data.price === "number" ? data.price : undefined,
        categoryPath: breadcrumbs && breadcrumbs.length > 0 ? breadcrumbs : undefined,
        inStock: data.availability === "available",
        observedAt: new Date(),
        raw: data,
    };
}

function parseCategorySpec(spec: string): LidlCategoryNode {
    const trimmed = spec.startsWith("/") ? spec.slice(1) : spec;
    const parts = trimmed.split("/");
    if (parts.length < 2) {
        return { path: trimmed, id: "", type: "unknown", url: trimmed };
    }

    const id = parts[parts.length - 1];
    const path = parts.slice(0, -1).join("/");
    const kind = id.startsWith("s") ? "category" : id.startsWith("h") ? "hub" : "unknown";
    return {
        path,
        id,
        type: kind,
        url: `${STORE_ROOT}/${kind === "category" ? "c" : "h"}/${path}/${id}`,
    };
}
