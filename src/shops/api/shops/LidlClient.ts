// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/lidl-daily/main.js

import { parseHTML } from "linkedom";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "../ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../ShopApiClient.types";
import type {
    LidlApiCategoryResponse,
    LidlApiItem,
    LidlCategoryNode,
    LidlCategoryType,
} from "./LidlClient.types";

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

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        throw new Error(
            `LidlClient.getProduct: not implemented in Phase 2 (input=${input.url ?? input.slug})`
        );
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
            const listing = await this.get<LidlApiCategoryResponse>(
                `/q/api/category/${node.path}/${node.id}`,
                {
                    params: {
                        offset,
                        fetchsize: FETCH_SIZE,
                        locale: "cs_CZ",
                        assortment: "CZ",
                        version: "2.1.0",
                    },
                    signal: opts.signal,
                }
            );
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
        const breadcrumbs = data.category
            ? data.category
                  .split("/")
                  .filter((s) => s.length > 0)
            : undefined;
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
