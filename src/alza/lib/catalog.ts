import { logger } from "@genesiscz/utils/logger";
import { parseHTML } from "linkedom";
import { type AlzaApi, AlzaApiError, type SearchSort } from "./api";
import type { CommodityCard, DiscussionPostRaw, ProductDetailRaw, ReviewItem } from "./schemas";
import type {
    CategoryFilters,
    CategoryInfo,
    ListingPage,
    ProductDetail,
    ProductSummary,
    Question,
    QuestionsResult,
    Review,
    ReviewsResult,
    Suggestions,
} from "./types";

const SEARCH_PAGE_SIZE = 25;
const REVIEWS_PAGE_SIZE = 50;
const QUESTIONS_PAGE_SIZE = 25;
const MAX_PAGES = 20;

/** "2 249,-", "1 859 Kč", "149,90 €" → 2249, 1859, 149.9. */
export function parsePrice(text: string | null | undefined): number | undefined {
    if (!text) {
        return undefined;
    }

    const cleaned = text
        .replace(/[\s ]/g, "")
        .replace(/,-$/, "")
        .replace(/[^\d,.-]/g, "");
    const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
    const value = Number.parseFloat(normalized);
    return Number.isFinite(value) && value > 0 ? value : undefined;
}

function discountOf(price: number | undefined, original: number | undefined): number | undefined {
    if (!price || !original || original <= price) {
        return undefined;
    }

    return Math.floor((1 - price / original) * 100);
}

/** A product code (`AUPR65708`), a numeric id (`9383715`) or a product URL (`…-d9383715.htm`, `?dq=9383715`). */
export function productIdFromRef(ref: string): number | undefined {
    const trimmed = ref.trim();
    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed);
    }

    const match = /[-/]d(\d+)\.htm/i.exec(trimmed) ?? /[?&]dq=(\d+)/i.exec(trimmed);
    return match ? Number(match[1]) : undefined;
}

export function cardToSummary(card: CommodityCard, currency: string, baseUrl: string): ProductSummary {
    const price = card.priceNoCurrency ?? card.priceInfoV2?.priceNoCurrency ?? parsePrice(card.price);
    const originalPrice = parsePrice(card.cprice ?? card.priceInfoV2?.comparePrice);
    return {
        id: card.id,
        code: card.code,
        name: card.name,
        url: card.url ?? `${baseUrl}/-d${card.id}.htm`,
        spec: card.spec ?? undefined,
        image: card.img ?? undefined,
        price,
        originalPrice: originalPrice && price && originalPrice > price ? originalPrice : undefined,
        discountPercent: discountOf(price, originalPrice),
        badge: card.priceInfoV2?.headerText ?? (card.is_action ? (card.action_name ?? undefined) : undefined),
        availability: card.avail ?? undefined,
        inStock: card.can_buy ?? undefined,
        rating: card.rating || undefined,
        ratingCount: card.ratingCount || undefined,
        currency,
    };
}

function detailToProduct(raw: ProductDetailRaw, currency: string, baseUrl: string): ProductDetail {
    const summary = cardToSummary(raw, currency, baseUrl);
    const price = summary.price ?? raw.gaPrice ?? undefined;
    const originalPrice = raw.cpriceNoCurrency ?? summary.originalPrice;
    const category = raw.seo_categories?.find((c) => c.catType === "CATEGORY") ?? raw.seo_categories?.[0];
    return {
        ...summary,
        price,
        originalPrice: originalPrice && price && originalPrice > price ? originalPrice : undefined,
        discountPercent: discountOf(price, originalPrice ?? undefined),
        inStock: raw.is_in_stock ?? summary.inStock,
        ean: raw.catalog_number ?? undefined,
        brandId: raw.producerId ?? undefined,
        warranty: raw.warranty ?? undefined,
        category: category ? { id: category.id, name: category.name } : undefined,
        deliveryNote: raw.avail_postfix ?? undefined,
        priceNote: raw.descriptionBeforeDiscount?.replace(/<[^>]+>/g, "").trim() || undefined,
        questionCount: raw.discussionPostCount ?? undefined,
        sold: raw.sales ?? undefined,
        images: (raw.imgs ?? []).map((i) => i.origUrl ?? i.big_url ?? i.url).filter((u): u is string => Boolean(u)),
        params: (raw.parameterGroups ?? []).flatMap((group) =>
            (group.params ?? []).map((param) => ({
                group: group.name,
                name: param.name,
                values: (param.values ?? []).map((v) => v.desc ?? "").filter(Boolean),
            }))
        ),
    };
}

export async function resolveProductId(api: AlzaApi, ref: string): Promise<number> {
    const direct = productIdFromRef(ref);
    if (direct !== undefined) {
        return direct;
    }

    const code = ref.trim();
    const result = await api.search({ term: code, page: 0, sort: "relevance" });
    const match = (result.data2 ?? []).find((card) => card.code.toLowerCase() === code.toLowerCase());
    if (!match) {
        throw new AlzaApiError(`No Alza product has the code ${code}. Pass the numeric id or the product URL.`, 404);
    }

    logger.debug({ code, id: match.id }, "alza code resolved");
    return match.id;
}

export interface SearchOptions {
    term: string;
    sort?: SearchSort;
    page?: number;
    limit?: number;
    brandId?: number;
    minPrice?: number;
    maxPrice?: number;
    inStock?: boolean;
    discounted?: boolean;
}

/** Keyword search over the app's v5 search route. Price, stock and discount filters apply to the fetched pages. */
export async function searchProducts(api: AlzaApi, opts: SearchOptions): Promise<ListingPage> {
    const limit = opts.limit ?? 20;
    const startPage = opts.page ?? 0;
    const items: ProductSummary[] = [];
    let total: number | undefined;
    let page = startPage;
    let hasMore = false;
    for (; page < startPage + MAX_PAGES; page++) {
        const result = await api.search({
            term: opts.term,
            page,
            sort: opts.sort ?? "relevance",
            producerIds: opts.brandId ? [opts.brandId] : undefined,
        });
        total = result.totalUnfiltered ?? total;
        const cards = result.data2 ?? [];
        for (const card of cards) {
            const item = cardToSummary(card, api.storefront.currency, api.storefront.baseUrl);
            if (matchesFilters(item, opts) && !items.some((i) => i.id === item.id)) {
                items.push(item);
            }
        }

        hasMore =
            cards.length >= SEARCH_PAGE_SIZE - 1 && (total === undefined || (page + 1) * SEARCH_PAGE_SIZE < total);
        if (items.length >= limit || !hasMore) {
            break;
        }
    }

    logger.debug({ term: opts.term, pages: page - startPage + 1, kept: items.length, total }, "alza search");
    return { total, page, hasMore, items: items.slice(0, limit) };
}

function matchesFilters(
    item: ProductSummary,
    opts: Pick<SearchOptions, "minPrice" | "maxPrice" | "inStock" | "discounted">
) {
    if (opts.minPrice !== undefined && (item.price === undefined || item.price < opts.minPrice)) {
        return false;
    }

    if (opts.maxPrice !== undefined && (item.price === undefined || item.price > opts.maxPrice)) {
        return false;
    }

    if (opts.inStock && item.inStock === false) {
        return false;
    }

    if (opts.discounted && !item.discountPercent) {
        return false;
    }

    return true;
}

export interface CategoryListingOptions {
    categoryId: number;
    page?: number;
    brandId?: number;
    params?: Array<{ paramId: number; valueId: number }>;
    limit?: number;
    minPrice?: number;
    maxPrice?: number;
    inStock?: boolean;
    discounted?: boolean;
}

/**
 * Alza's filtered category URL: only the numeric suffix matters (`{id}[-v{brand}][-par{param}-{value}]…[-p{page}]`),
 * the slug is cosmetic. Shape from alza-mcp-community `buildFilteredCategoryUrl` (MIT), paging seen live 2026-11-01.
 */
export function categoryListingPath(
    opts: Pick<CategoryListingOptions, "categoryId" | "brandId" | "params">,
    page: number
) {
    const parts = [String(opts.categoryId)];
    if (opts.brandId) {
        parts.push(`v${opts.brandId}`);
    }

    for (const p of opts.params ?? []) {
        parts.push(`par${p.paramId}-${p.valueId}`);
    }

    if (page > 1) {
        parts.push(`p${page}`);
    }

    return `/${parts.join("-")}.htm`;
}

/** Product cards of a server-rendered listing page (a category, or a search the storefront turned into one). */
export function parseListingCards(
    html: string,
    currency: string,
    baseUrl: string
): { items: ProductSummary[]; total?: number; pages: number[] } {
    const { document } = parseHTML(html);
    const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() || undefined;
    const items: ProductSummary[] = [];
    for (const card of document.querySelectorAll(".browsingitem")) {
        const code = card.getAttribute("data-code");
        const id = Number(card.getAttribute("data-id"));
        const nameEl = card.querySelector("a.name");
        const name = text(nameEl);
        if (!code || !id || !name) {
            continue;
        }

        const href = nameEl?.getAttribute("href") ?? `/-d${id}.htm`;
        const price = parsePrice(text(card.querySelector(".ads-pb__price-value")));
        const originalPrice = parsePrice(text(card.querySelector(".ads-pb__original-price")));
        const rating = Number.parseFloat(
            (text(card.querySelector(".star-rating-block__value")) ?? "").replace(",", ".")
        );
        const ratingCount = Number.parseInt(
            (text(card.querySelector(".star-rating-block__count")) ?? "").replace(/\D/g, ""),
            10
        );
        items.push({
            id,
            code,
            name,
            url: href.startsWith("http") ? href : `${baseUrl}${href}`,
            spec: text(card.querySelector(".Description")),
            image: card.querySelector("img")?.getAttribute("src") ?? undefined,
            price,
            originalPrice: originalPrice && price && originalPrice > price ? originalPrice : undefined,
            discountPercent: discountOf(price, originalPrice),
            badge: text(card.querySelector(".ads-pb__header")),
            availability: text(card.querySelector(".avlVal")),
            inStock: (card.getAttribute("class") ?? "").split(/\s+/).includes("canBuy"),
            rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
            ratingCount: Number.isFinite(ratingCount) && ratingCount > 0 ? ratingCount : undefined,
            currency,
        });
    }

    const pages = new Set<number>();
    for (const a of document.querySelectorAll("a[href]")) {
        const m = /-p(\d+)\.htm/.exec(a.getAttribute("href") ?? "");
        if (m) {
            pages.add(Number(m[1]));
        }
    }

    const countText = text(document.querySelector("#lblNumberItem, .numberItem"));
    const total = countText ? Number.parseInt(countText.replace(/\D/g, ""), 10) || undefined : undefined;
    return { items, total, pages: [...pages].sort((a, b) => a - b) };
}

export async function listCategory(api: AlzaApi, opts: CategoryListingOptions): Promise<ListingPage> {
    const limit = opts.limit ?? 24;
    const startPage = Math.max(1, opts.page ?? 1);
    const items: ProductSummary[] = [];
    let total: number | undefined;
    let page = startPage;
    let hasMore = false;
    for (; page < startPage + MAX_PAGES; page++) {
        const { html } = await api.html(categoryListingPath(opts, page));
        const parsed = parseListingCards(html, api.storefront.currency, api.storefront.baseUrl);
        total = parsed.total ?? total;
        for (const item of parsed.items) {
            if (matchesFilters(item, opts) && !items.some((i) => i.id === item.id)) {
                items.push(item);
            }
        }

        hasMore = parsed.items.length > 0 && parsed.pages.some((p) => p > page);
        if (items.length >= limit || !hasMore) {
            break;
        }
    }

    logger.debug({ categoryId: opts.categoryId, pages: page - startPage + 1, kept: items.length }, "alza category");
    return { total, page, hasMore, items: items.slice(0, limit) };
}

export async function getProduct(api: AlzaApi, ref: string): Promise<ProductDetail> {
    const id = await resolveProductId(api, ref);
    const response = await api.product(id);
    if (!response.data) {
        throw new AlzaApiError(`Alza has no product ${id}${response.msg ? `: ${response.msg}` : ""}`, 404);
    }

    return detailToProduct(response.data, api.storefront.currency, api.storefront.baseUrl);
}

/** "Hodnoceno 25.09.2026, varianta X" → { date: "2026-09-25", variant: "X" }. */
export function parseReviewDetail(detail: string | null | undefined): { date?: string; variant?: string } {
    if (!detail) {
        return {};
    }

    const date = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(detail);
    const variant = /,\s*(?:varianta|variant|változat|Variante)\s+(.+)$/i.exec(detail);
    return {
        date: date ? `${date[3]}-${date[2].padStart(2, "0")}-${date[1].padStart(2, "0")}` : undefined,
        variant: variant?.[1]?.trim(),
    };
}

export function toReview(item: ReviewItem): Review {
    const { date, variant } = parseReviewDetail(item.reviewDetail);
    return {
        author: item.name ?? undefined,
        date,
        rating: item.rating,
        text: item.description?.trim() || undefined,
        pros: item.positives ?? [],
        cons: item.negatives ?? [],
        verified: item.verifiedPurchase ?? false,
        likes: item.likeCount ?? 0,
        variant,
        country: /\/country\/([a-z]{2})\.svg/i.exec(item.flagUrl ?? "")?.[1]?.toUpperCase(),
        translated: item.isTranslated ?? false,
        imageCount: item.images?.length ?? 0,
    };
}

export async function getReviews(api: AlzaApi, ref: string, opts: { limit?: number } = {}): Promise<ReviewsResult> {
    const id = await resolveProductId(api, ref);
    const limit = opts.limit ?? 50;
    const reviews: Review[] = [];
    for (
        let offset = 0;
        reviews.length < limit && offset / REVIEWS_PAGE_SIZE < MAX_PAGES;
        offset += REVIEWS_PAGE_SIZE
    ) {
        const page = await api.reviews(id, { limit: REVIEWS_PAGE_SIZE, offset });
        const items = page.items ?? [];
        reviews.push(...items.map(toReview));
        if (items.length < REVIEWS_PAGE_SIZE) {
            break;
        }
    }

    const kept = reviews.slice(0, limit);
    const distribution: ReviewsResult["distribution"] = [0, 0, 0, 0, 0];
    for (const review of reviews) {
        const star = Math.min(5, Math.max(1, Math.round(review.rating)));
        distribution[star - 1]++;
    }

    const average = reviews.length ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : undefined;
    return { productId: id, total: reviews.length, average, distribution, reviews: kept };
}

function toQuestion(raw: DiscussionPostRaw): Question {
    return {
        id: raw.id,
        author: (typeof raw.user === "string" ? raw.user : raw.user?.name) || undefined,
        text: raw.text?.trim() ?? "",
        created: raw.created ? new Date(raw.created * 1000).toISOString() : undefined,
        upVotes: raw.upVotes ?? 0,
        downVotes: raw.downVotes ?? 0,
        answerCount: raw.children_cnt ?? 0,
        answers: [],
    };
}

/** Product questions and Alza's or other buyers' answers. Upstream posts carry the asker's email; it is never read. */
export async function getQuestions(
    api: AlzaApi,
    ref: string,
    opts: { limit?: number; answers?: boolean } = {}
): Promise<QuestionsResult> {
    const id = await resolveProductId(api, ref);
    const limit = opts.limit ?? 25;
    const questions: Question[] = [];
    let total = 0;
    for (
        let pageStart = 0;
        questions.length < limit && pageStart / QUESTIONS_PAGE_SIZE < MAX_PAGES;
        pageStart += QUESTIONS_PAGE_SIZE
    ) {
        const page = await api.discussion(id, { pageStart, pageSize: QUESTIONS_PAGE_SIZE });
        total = page.totalCnt ?? total;
        questions.push(...(page.items ?? []).map(toQuestion));
        if (!page.hasNext) {
            break;
        }
    }

    const kept = questions.slice(0, limit);
    if (opts.answers ?? true) {
        await Promise.all(
            kept
                .filter((q) => q.answerCount > 0)
                .map(async (q) => {
                    const replies = await api.discussion(id, {
                        pageStart: 0,
                        pageSize: QUESTIONS_PAGE_SIZE,
                        parentId: q.id,
                    });
                    q.answers = (replies.items ?? []).map(toQuestion);
                })
        );
    }

    return { productId: id, total: total || questions.length, questions: kept };
}

export async function compareProducts(api: AlzaApi, refs: string[]): Promise<ProductDetail[]> {
    return Promise.all(refs.map((ref) => getProduct(api, ref)));
}

/**
 * Alza's own alternatives for a product. The route answers an empty list for many products; then the best-rated
 * other products of its category stand in, and `source` says which list it is.
 */
export async function getAlternatives(
    api: AlzaApi,
    ref: string,
    opts: { limit?: number } = {}
): Promise<{ source: "alza" | "category"; product: ProductDetail; items: ProductSummary[] }> {
    const product = await getProduct(api, ref);
    const limit = opts.limit ?? 10;
    const response = await api.alternatives(product.id);
    const own = (response.data ?? []).map((card) =>
        cardToSummary(card, api.storefront.currency, api.storefront.baseUrl)
    );
    if (own.length > 0) {
        return { source: "alza", product, items: own.slice(0, limit) };
    }

    if (!product.category) {
        return { source: "alza", product, items: [] };
    }

    const listing = await listCategory(api, { categoryId: product.category.id, limit: 72 });
    const items = listing.items
        .filter((item) => item.id !== product.id)
        .sort(
            (a, b) =>
                (b.rating ?? 0) * Math.log1p(b.ratingCount ?? 0) - (a.rating ?? 0) * Math.log1p(a.ratingCount ?? 0)
        )
        .slice(0, limit);
    return { source: "category", product, items };
}

function nameAndId(action: { webLink?: string | null; href?: string | null; name?: string | null } | null | undefined) {
    const name = action?.name ?? "";
    const idMatch = /\/(\d+)(?:\?|$)/.exec(action?.href ?? "");
    return {
        name,
        id: idMatch ? Number(idMatch[1]) : undefined,
        url: action?.webLink?.replace(/\?.*$/, "") ?? undefined,
    };
}

export async function autocomplete(api: AlzaApi, term: string): Promise<Suggestions> {
    const response = await api.whisper(term);
    return {
        phrases: (response.phrases ?? []).map((p) => p.clickAction?.name ?? "").filter(Boolean),
        products: (response.commodities ?? []).map((c) => nameAndId(c.clickAction)).filter((p) => p.name),
        categories: (response.categories ?? []).map((c) => nameAndId(c.clickAction)).filter((c) => c.name),
        brands: (response.producers ?? [])
            .map((p) => ({
                name: p.clickAction?.name ?? "",
                url: p.clickAction?.webLink?.replace(/\?.*$/, "") ?? undefined,
            }))
            .filter((b) => b.name),
    };
}

export async function getCategoryFilters(api: AlzaApi, categoryId: number): Promise<CategoryFilters> {
    const response = await api.facets(categoryId);
    const value = (v: { v: number; desc?: string | null; cnt?: number | null }) => ({
        id: v.v,
        name: v.desc ?? String(v.v),
        count: v.cnt ?? undefined,
    });
    return {
        categoryId,
        brands: (response.producers ?? []).map(value),
        facets: (response.params ?? []).flatMap((block) =>
            (block.groups ?? []).flatMap((group) =>
                (group.params ?? []).map((param) => ({
                    group: group.name,
                    paramId: param.tId,
                    name: param.name,
                    kind: param.renderType ?? undefined,
                    values: (param.values ?? []).map(value),
                }))
            )
        ),
        priceSteps: (response.prices ?? []).map((p) => p.k),
    };
}

export async function getCategory(api: AlzaApi, categoryId: number): Promise<CategoryInfo> {
    const response = await api.category(categoryId);
    return {
        id: categoryId,
        name: response.cat_name ?? undefined,
        url: `${api.storefront.baseUrl}/${categoryId}.htm`,
        breadcrumbs: (response.breadcrumbs ?? []).map((b) => b.category?.name ?? "").filter(Boolean),
        children: (response.data ?? [])
            .filter((c) => c.name)
            .map((c) => ({ id: c.id || undefined, name: c.name ?? "", url: c.self?.webLink ?? undefined })),
    };
}

export async function productsByEan(
    api: AlzaApi,
    eans: string[]
): Promise<Array<{ ean: string; product?: ProductDetail }>> {
    return Promise.all(
        eans.map(async (ean) => {
            const response = await api.productByEan(ean);
            const product = response.data
                ? detailToProduct(response.data, api.storefront.currency, api.storefront.baseUrl)
                : undefined;
            return { ean, product };
        })
    );
}

export interface DealsOptions {
    term?: string;
    categoryId?: number;
    minDiscount?: number;
    limit?: number;
    pages?: number;
}

/** Discounted products of a search or a category, the biggest discount first. */
export async function getDeals(api: AlzaApi, opts: DealsOptions): Promise<ListingPage> {
    const scanLimit = (opts.pages ?? 4) * SEARCH_PAGE_SIZE;
    let listing: ListingPage;
    if (opts.categoryId) {
        listing = await listCategory(api, { categoryId: opts.categoryId, limit: scanLimit, discounted: true });
    } else if (opts.term) {
        listing = await searchProducts(api, { term: opts.term, limit: scanLimit, discounted: true });
    } else {
        throw new AlzaApiError("Deals need a search term or a category id.", 400);
    }

    const items = listing.items
        .filter((item) => (item.discountPercent ?? 0) >= (opts.minDiscount ?? 1))
        .sort((a, b) => (b.discountPercent ?? 0) - (a.discountPercent ?? 0))
        .slice(0, opts.limit ?? 30);
    return { ...listing, items };
}
