/**
 * AlbertClient — albert.cz GraphQL persisted-query proxy.
 *
 * Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/albert/main.js.
 *
 * The actor extracts persisted-query SHA-256 hashes at runtime via Playwright
 * network interception. Phase 2 hardcodes them with a refresh runbook below.
 *
 * Hash refresh runbook:
 *   1. Open https://www.albert.cz/online in Chrome.
 *   2. DevTools -> Network tab -> filter by "extensions=" in URLs.
 *   3. Copy the `extensions` query param value of a GraphQL request.
 *   4. URL-decode + SafeJSON.parse it -> persistedQuery.sha256Hash is the new hash.
 *   5. Update ALBERT_PERSISTED_QUERY_HASHES with one hash per operation name.
 *   6. Run: bun test src/shops/api/shops/AlbertClient.test.ts
 *      (live-smoke-phase2 must pass with RUN_LIVE_SMOKE=1).
 *   7. Commit with message: "fix(shops/albert): refresh persisted-query hashes".
 *
 * If the hash is wrong, Albert returns
 *   { errors: [{ message: "PersistedQueryNotFound", ... }] }
 * — the client throws a clear error pointing at this runbook.
 */

import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import type {
    AlbertCategoryProductSearchResponse,
    AlbertNavigationResponse,
    AlbertRawProduct,
} from "@app/shops/api/shops/AlbertClient.types";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

const ALBERT_ORIGIN = "albert.cz";
const STORE_ROOT = "https://www.albert.cz";
const API_PATH = "/api/v1/";
const PAGE_SIZE = 20;

/**
 * Persisted-query SHA-256 hashes per operationName. Last refreshed
 * 2026-05-09 from the actor's documented values. Refresh per the runbook
 * in this file's JSDoc when Albert returns `PersistedQueryNotFound`.
 */
export const ALBERT_PERSISTED_QUERY_HASHES: Readonly<Record<string, string>> = Object.freeze({
    LeftHandNavigationBar: "d4fbb58dccba05abc15c0a70cb5da9bdb98ac8aa4fbd859bd83e52c15a9be36c",
    // TODO: Replace with real hash captured from DevTools. Current value is an
    // intentional placeholder until the Phase 2 capture run lands; live-smoke
    // will fail loudly with `PersistedQueryNotFound` when the hash is wrong,
    // making the missing capture visible. See JSDoc runbook above for steps.
    GetCategoryProductSearch: "4ef83505000000000000000000000000000000000000000000000000000000ff",
});

/** Apollo client headers required to bypass Albert's CSRF check. */
const APOLLO_HEADERS = {
    "apollographql-client-name": "cz-alb-web-stores",
    "apollographql-client-version": "9f7f73067ae74ca1179954e9a94f3a23f1822b6b",
    "content-type": "application/json",
};

function loadHashes(): Readonly<Record<string, string>> {
    const override = env.shops.getAlbertPersistedQueryHashesJson();
    if (override) {
        try {
            return Object.freeze(SafeJSON.parse(override) as Record<string, string>);
        } catch {
            return ALBERT_PERSISTED_QUERY_HASHES;
        }
    }

    return ALBERT_PERSISTED_QUERY_HASHES;
}

function buildPersistedQueryParams(operationName: string, variables: Record<string, unknown>): Record<string, string> {
    const hashes = loadHashes();
    const sha256Hash = hashes[operationName];
    if (!sha256Hash) {
        throw new Error(
            `AlbertClient: no persisted-query hash for '${operationName}'. See refresh runbook in AlbertClient.ts JSDoc.`
        );
    }

    return {
        operationName,
        variables: SafeJSON.stringify(variables),
        extensions: SafeJSON.stringify({ persistedQuery: { version: 1, sha256Hash } }),
    };
}

export class AlbertClient extends ShopApiClient {
    readonly shopOrigin = ALBERT_ORIGIN;
    readonly displayName = "Albert.cz";
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
            loggerContext: { provider: "albert" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 2,
            headers: { ...APOLLO_HEADERS, ...(config.headers ?? {}) },
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        throw new Error(`AlbertClient.getProduct: not implemented in Phase 2 (input=${input.url ?? input.slug})`);
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("AlbertClient.listCategory requires opts.category (Albert categoryCode)");
        }

        let yielded = 0;
        let page = 0;
        let totalPages = 1;
        const params = (currentPage: number) =>
            buildPersistedQueryParams("GetCategoryProductSearch", {
                lang: "cs",
                searchQuery: "",
                category: opts.category,
                pageNumber: currentPage,
                pageSize: PAGE_SIZE,
                filterFlag: true,
                plainChildCategories: true,
            });

        while (page < totalPages) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const resp = await this.get<AlbertCategoryProductSearchResponse>(API_PATH, {
                params: { ...params(page), "x-apollo-operation-name": "GetCategoryProductSearch" },
                headers: { "x-apollo-operation-name": "GetCategoryProductSearch" },
                signal: opts.signal,
            });

            ensureNoErrors(resp.errors, "GetCategoryProductSearch");
            const search = resp.data?.categoryProductSearch;
            const products = search?.products ?? [];
            if (products.length === 0) {
                return;
            }

            const breadcrumbs = (search?.categoryBreadcrumbs ?? []).map((b) => b.name);
            for (const product of products) {
                yield this.toRawProduct(product, breadcrumbs);
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }

            totalPages = search?.pagination?.totalPages ?? 1;
            page++;
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const resp = await this.get<AlbertNavigationResponse>(API_PATH, {
            params: {
                ...buildPersistedQueryParams("LeftHandNavigationBar", {
                    rootCategoryCode: "",
                    cutOffLevel: "5",
                    lang: "cs",
                }),
                "x-apollo-operation-name": "LeftHandNavigationBar",
            },
            headers: { "x-apollo-operation-name": "LeftHandNavigationBar" },
        });

        ensureNoErrors(resp.errors, "LeftHandNavigationBar");
        const out: Category[] = [];
        const tree = resp.data?.leftHandNavigationBar?.categoryTreeList ?? [];
        for (const root of tree) {
            out.push({
                id: root.categoryCode,
                name: root.categoryName,
                slug: root.categoryCode,
            });
            for (const child of root.categoriesInfo ?? []) {
                out.push({
                    id: child.categoryCode,
                    name: child.categoryName,
                    parentId: root.categoryCode,
                    slug: child.categoryCode,
                });
            }
        }

        return out;
    }

    private toRawProduct(p: AlbertRawProduct, categoryPath: string[]): RawProduct {
        const slug = p.code;
        const url = new URL(p.url, STORE_ROOT).href;
        const currentPrice = parseDiscountedPrice(p.price?.discountedPriceFormatted) ?? p.price?.value;
        const originalPrice =
            p.price?.discountedPriceFormatted && p.price?.value !== undefined ? p.price.value : undefined;
        return {
            shopOrigin: ALBERT_ORIGIN,
            slug,
            itemId: p.code,
            url,
            name: p.name,
            imageUrl: p.images?.[0]?.url,
            categoryPath: categoryPath.length > 0 ? categoryPath : undefined,
            currentPrice,
            originalPrice,
            inStock: p.stock?.inStock,
            observedAt: new Date(),
            raw: p,
        };
    }
}

function parseDiscountedPrice(formatted: string | null | undefined): number | undefined {
    if (!formatted) {
        return undefined;
    }

    const cleaned = formatted
        .replace(/[^\d,.\s]/g, "")
        .replace(/\s+/g, "")
        .replace(/,/g, ".");
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : undefined;
}

function ensureNoErrors(
    errors: Array<{ message: string; reasonCode?: string }> | undefined,
    operationName: string
): void {
    if (!errors || errors.length === 0) {
        return;
    }

    const first = errors[0];
    if (first.reasonCode === "PERSISTED_QUERY_NOT_FOUND" || first.message.includes("PersistedQueryNotFound")) {
        throw new Error(`Albert ${operationName}: PersistedQueryNotFound — refresh hashes per AlbertClient.ts runbook`);
    }

    throw new Error(`Albert ${operationName} returned errors: ${SafeJSON.stringify(errors)}`);
}
