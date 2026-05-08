// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/itesco-daily/main.js

import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { parseHTML } from "linkedom";
import { isAkamaiBlock } from "../../lib/akamai-detect";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "../ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../ShopApiClient.types";
import {
    ITESCO_BASE_URL,
    ITESCO_BROWSER_UA,
    ITESCO_CZ_SALE_REGEX,
    ITESCO_DEFAULT_PAGE_SIZE,
    ITESCO_HOME_URL,
    ITESCO_LOCALE,
    ITESCO_SUPERDEPT_REGEX,
    type ItescoApolloCache,
    type ItescoApolloEntry,
    type ItescoBreadcrumbNode,
    type ItescoDiscoverJson,
    type ItescoPageInfo,
} from "./ItescoClient.types";

const ITESCO_ORIGIN = "itesco.cz";

const DEFAULT_BACKOFF_MS: readonly number[] = [
    30_000, // attempt 1: 30s
    120_000, // attempt 2: 2 min
    300_000, // attempt 3: 5 min
];

export interface ItescoClientConfig extends ShopApiClientConstructorConfig {
    /** Backoff schedule on Akamai blocks. Tests pass shorter values. */
    backoffMs?: readonly number[];
}

export class ItescoClient extends ShopApiClient {
    readonly shopOrigin = ITESCO_ORIGIN;
    readonly displayName = "Tesco CZ";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: false,
        search: false,
        botProtection: "akamai",
    };

    private readonly clientLog = logger.child({ component: "ItescoClient", shop: ITESCO_ORIGIN });
    private readonly backoffMs: readonly number[];

    constructor(config: ItescoClientConfig = {}) {
        super({
            baseUrl: ITESCO_BASE_URL,
            loggerContext: { provider: "itesco" },
            // 0.5 req/s — Akamai-fronted; cold visitor mode (no session reuse).
            rateLimitPerSecond: config.rateLimitPerSecond ?? 0.5,
            headers: { "User-Agent": ITESCO_BROWSER_UA, ...config.headers },
            ...config,
        });
        this.backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;
    }

    async listCategories(): Promise<Category[]> {
        const html = await this.fetchAkamaiAware(ITESCO_HOME_URL);
        const { document } = parseHTML(html);

        const seen = new Set<string>();
        const out: Category[] = [];
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
            const href = (a.getAttribute("href") ?? "").trim();
            const m = ITESCO_SUPERDEPT_REGEX.exec(href);
            if (!m) {
                continue;
            }

            const url = `${ITESCO_BASE_URL}${m[1]}`;
            if (seen.has(url)) {
                continue;
            }

            seen.add(url);
            const slug = (m[1] ?? "").split("/").filter(Boolean).slice(-2)[0] ?? m[1] ?? "";
            out.push({
                id: m[1] ?? "",
                name: (a.textContent ?? "").trim() || slug,
                slug,
                url,
            });
        }

        return out;
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("ItescoClient.listCategory requires opts.category (a category URL)");
        }

        const baseUrl = opts.category.startsWith("http") ? opts.category : `${ITESCO_BASE_URL}${opts.category}`;
        const limit = opts.limit ?? Number.POSITIVE_INFINITY;

        opts.signal?.throwIfAborted();
        const firstHtml = await this.fetchAkamaiAware(baseUrl, opts.signal);
        const firstDoc = parseHTML(firstHtml).document;

        const observedAt = new Date();
        let yielded = 0;
        const seenIds = new Set<number>();
        for (const product of extractItemsFromDocument(firstDoc, baseUrl, observedAt, seenIds, this.clientLog)) {
            if (yielded >= limit) {
                return;
            }

            yield product;
            yielded++;
        }

        if (yielded >= limit) {
            return;
        }

        const pageInfo = extractPageInfo(firstDoc);
        if (!pageInfo) {
            return;
        }

        const lastPage = Math.ceil(pageInfo.total / pageInfo.pageSize);
        for (let page = 2; page <= lastPage && yielded < limit; page++) {
            opts.signal?.throwIfAborted();
            const url = `${baseUrl}?page=${page}`;
            const html = await this.fetchAkamaiAware(url, opts.signal);
            const { document } = parseHTML(html);
            for (const product of extractItemsFromDocument(document, baseUrl, observedAt, seenIds, this.clientLog)) {
                if (yielded >= limit) {
                    return;
                }

                yield product;
                yielded++;
            }
        }
    }

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        const url =
            input.url ?? (input.slug ? `${ITESCO_BASE_URL}/groceries/${ITESCO_LOCALE}/products/${input.slug}` : null);
        if (!url) {
            throw new Error("ItescoClient.getProduct requires url or slug");
        }

        const html = await this.fetchAkamaiAware(url);
        const { document } = parseHTML(html);

        const observedAt = new Date();
        const seenIds = new Set<number>();
        const items = Array.from(extractItemsFromDocument(document, url, observedAt, seenIds, this.clientLog));
        const m = url.match(/\/products\/(\d+)/);
        const targetId = m ? Number.parseInt(m[1] ?? "", 10) : null;
        const found =
            targetId !== null && Number.isFinite(targetId)
                ? items.find((p) => Number.parseInt(p.itemId ?? "", 10) === targetId)
                : items[0];
        if (!found) {
            throw new Error(`ItescoClient.getProduct: product ${targetId ?? url} not found in Apollo cache`);
        }

        return found;
    }

    /**
     * GET wrapper that detects Akamai blocks (status, body markers) and applies an
     * exponential backoff up to `backoffMs.length` retries before giving up. After the
     * last attempt the throw bubbles to the ShopCrawler base, which records the run as
     * `failed` with the error message.
     */
    private async fetchAkamaiAware(url: string, signal?: AbortSignal): Promise<string> {
        let lastErr: unknown;
        for (let attempt = 0; attempt <= this.backoffMs.length; attempt++) {
            signal?.throwIfAborted();
            await this.waitTurn();
            try {
                const html = await this.getText(url, { signal });
                if (isAkamaiBlock({ status: 200, body: html, setCookie: [] })) {
                    throw new Error(`Akamai bot challenge body for ${url}`);
                }

                return html;
            } catch (err) {
                lastErr = err;
                const e = err as Error & { status?: number; body?: string };
                const blocked =
                    typeof e?.status === "number"
                        ? isAkamaiBlock({ status: e.status, body: e.body ?? "", setCookie: [] })
                        : /Akamai|sec-if-cpt|HTTP 40[39]|HTTP 429|HTTP 503/i.test(e?.message ?? "");
                if (!blocked) {
                    throw err;
                }

                if (attempt === this.backoffMs.length) {
                    break;
                }

                const waitMs = this.backoffMs[attempt] ?? 0;
                this.clientLog.warn(
                    { attempt: attempt + 1, waitMs, url, error: e.message ?? String(e) },
                    "itesco: Akamai block detected — backing off"
                );
                await Bun.sleep(waitMs);
            }
        }

        const msg =
            `Akamai escalation: ${this.backoffMs.length} backoffs exceeded for ${url}; ` +
            `underlying: ${(lastErr as Error)?.message ?? String(lastErr)}`;
        const finalErr = new Error(msg);
        (finalErr as Error & { code?: string }).code = "AKAMAI_ESCALATION";
        throw finalErr;
    }
}

export function parseDiscoverJson(document: Document): ItescoDiscoverJson | null {
    const script = document.querySelector('script[type="application/discover+json"]');
    if (!script) {
        return null;
    }

    const text = script.textContent ?? "";
    if (!text.trim()) {
        return null;
    }

    try {
        return SafeJSON.parse(text) as ItescoDiscoverJson;
    } catch {
        return null;
    }
}

export function breadcrumbTrail(nodes: ItescoBreadcrumbNode[] | undefined): string[] {
    if (!Array.isArray(nodes)) {
        return [];
    }

    for (const node of nodes) {
        if (node?.current) {
            const deeper = breadcrumbTrail(node.children);
            return [node.text ?? "", ...deeper].filter(Boolean);
        }

        const deeper = breadcrumbTrail(node?.children);
        if (deeper.length > 0) {
            return [node.text ?? "", ...deeper].filter(Boolean);
        }
    }

    return [];
}

export function extractCategoryBreadcrumb(document: Document): string[] {
    const el = document.querySelector("[data-plp-breadcrumb]");
    if (!el) {
        return [];
    }

    const attr = el.getAttribute("data-plp-breadcrumb");
    if (!attr) {
        return [];
    }

    try {
        const data = SafeJSON.parse(attr) as ItescoBreadcrumbNode[];
        return breadcrumbTrail(data).filter(Boolean);
    } catch {
        return [];
    }
}

export function extractPageInfo(document: Document): ItescoPageInfo | null {
    const discover = parseDiscoverJson(document);
    const rootQuery = discover?.["mfe-orchestrator"]?.props?.apolloCache?.ROOT_QUERY ?? {};
    if (typeof rootQuery !== "object" || rootQuery === null) {
        return null;
    }

    for (const [key, value] of Object.entries(rootQuery)) {
        if (!key.startsWith("category(")) {
            continue;
        }

        const v = value as ItescoApolloEntry;
        if (v?.info?.total != null) {
            return {
                total: v.info.total,
                pageSize: v.info.count ?? ITESCO_DEFAULT_PAGE_SIZE,
            };
        }
    }

    return null;
}

function* extractItemsFromDocument(
    document: Document,
    pageUrl: string,
    observedAt: Date,
    seenIds: Set<number>,
    log: typeof logger
): Iterable<RawProduct> {
    const discover = parseDiscoverJson(document);
    const apolloCache: ItescoApolloCache =
        (discover?.["mfe-orchestrator"]?.props?.apolloCache as ItescoApolloCache | undefined) ?? {};
    const breadcrumb = extractCategoryBreadcrumb(document);

    const resolvePromo = (ref: unknown): ItescoApolloEntry | null => {
        if (!ref) {
            return null;
        }

        const key = (ref as { __ref?: string }).__ref ?? (typeof ref === "string" ? ref : null);
        if (!key) {
            return null;
        }

        return (apolloCache[key] as ItescoApolloEntry | undefined) ?? null;
    };

    for (const [key, product] of Object.entries(apolloCache)) {
        if (!key.startsWith("ProductType:")) {
            continue;
        }

        if (!product || typeof product !== "object") {
            continue;
        }

        const p = product as ItescoApolloEntry;
        const itemIdNum = Number.parseInt(String(p.id ?? ""), 10);
        if (!Number.isFinite(itemIdNum) || seenIds.has(itemIdNum)) {
            continue;
        }

        seenIds.add(itemIdNum);

        const price = p.price ?? {};
        const itemUrl = `${ITESCO_BASE_URL}/groceries/${ITESCO_LOCALE}/products/${p.id}`;

        let currentPrice: number | undefined = typeof price.actual === "number" ? price.actual : undefined;
        let originalPrice: number | undefined;

        const offerText = (p.promotions ?? [])
            .map(resolvePromo)
            .map((promo) => promo?.description)
            .find((desc) => typeof desc === "string" && !desc.includes("Clubcard"));
        if (typeof offerText === "string") {
            const match = ITESCO_CZ_SALE_REGEX.exec(offerText);
            if (match) {
                const cleaned = (match[1] ?? "").replace(/\s+/g, "").replace(/,/g, ".");
                const parsed = Number.parseFloat(cleaned);
                if (Number.isFinite(parsed) && parsed > 0) {
                    originalPrice = parsed;
                }
            }
        }

        const weighable = p.displayType === "QuantityOrWeight" || p.productType === "LooseProduce";
        if (weighable) {
            if (typeof currentPrice === "number") {
                currentPrice /= 10;
            }

            if (typeof originalPrice === "number") {
                originalPrice /= 10;
            }
        }

        const inStock = p.status === "AvailableForSale";
        if (currentPrice == null && inStock) {
            log.warn({ itemId: itemIdNum, itemUrl }, "itesco: missing price on in-stock item");
        }

        yield {
            shopOrigin: ITESCO_ORIGIN,
            slug: String(p.id),
            itemId: String(itemIdNum),
            url: itemUrl,
            name: p.title ?? "",
            imageUrl: p.defaultImageUrl,
            currentPrice,
            originalPrice,
            inStock,
            categoryPath: breadcrumb.length > 0 ? breadcrumb : undefined,
            unit: weighable ? "0.1kg" : undefined,
            observedAt,
            raw: {
                pageUrl,
                productKey: key,
                weighable,
            },
        };
    }
}
