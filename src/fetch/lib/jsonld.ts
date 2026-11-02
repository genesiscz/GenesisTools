import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * schema.org JSON-LD out of a page: the Product facts a price comparison needs (every offer with its seller, price,
 * currency and availability) and the breadcrumb trail. Generic: no per-site code, only schema.org vocabulary.
 */

export interface JsonLdOffer {
    seller: string | null;
    price: number | null;
    currency: string | null;
    /** schema.org name without the URL prefix: `InStock`, `OutOfStock`, `PreOrder`. */
    availability: string | null;
    condition: string | null;
    url: string | null;
}

export interface JsonLdRating {
    value: number | null;
    best: number | null;
    worst: number | null;
    ratingCount: number | null;
    reviewCount: number | null;
}

export interface JsonLdProduct {
    type: string;
    name: string | null;
    brand: string | null;
    sku: string | null;
    gtin: string | null;
    mpn: string | null;
    url: string | null;
    category: string | null;
    description: string | null;
    images: string[];
    rating: JsonLdRating | null;
    /** From an AggregateOffer when the page has one, else computed from the offers. */
    priceRange: { low: number | null; high: number | null; currency: string | null; offerCount: number | null } | null;
    offers: JsonLdOffer[];
    properties: Array<{ name: string; value: string }>;
}

export interface JsonLdCrumb {
    position: number | null;
    name: string | null;
    url: string | null;
}

export interface JsonLdData {
    /** `<script type="application/ld+json">` blocks found, and how many of them did not parse. */
    blocks: number;
    parseErrors: number;
    products: JsonLdProduct[];
    breadcrumbs: JsonLdCrumb[][];
    /** Every other typed top-level node, by type and name, so a caller knows what else the page describes. */
    other: Array<{ type: string; name: string | null }>;
}

type JsonObject = Record<string, unknown>;

const SCRIPT_RE = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
const DESCRIPTION_CHARS = 500;
const MAX_IMAGES = 10;
const PRODUCT_TYPES = new Set(["Product", "ProductGroup", "IndividualProduct", "ProductModel"]);

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
    if (value === undefined || value === null) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
}

function typesOf(node: JsonObject): string[] {
    return asArray(node["@type"])
        .filter((type): type is string => typeof type === "string")
        .map((type) => type.replace(/^https?:\/\/schema\.org\//, ""));
}

function decodeEntities(text: string): string {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

/** A string, or the name / @id of a nested thing (`brand: {"@type":"Brand","name":"X"}`). */
function text(value: unknown): string | null {
    if (typeof value === "string") {
        const trimmed = decodeEntities(value).trim();
        return trimmed || null;
    }

    if (typeof value === "number") {
        return String(value);
    }

    if (Array.isArray(value)) {
        return text(value[0]);
    }

    if (isObject(value)) {
        return text(value.name) ?? text(value["@id"]) ?? text(value.url);
    }

    return null;
}

/** 7990, "7990", "7990.00", "7 990,50" and "1,234.50" become numbers; anything else null. */
export function parsePrice(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value !== "string") {
        return null;
    }

    let cleaned = value.replace(/[\s ]/g, "").replace(/[^\d.,-]/g, "");
    if (cleaned.includes(",") && cleaned.includes(".")) {
        cleaned =
            cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
                ? cleaned.replace(/\./g, "").replace(",", ".")
                : cleaned.replace(/,/g, "");
    } else if (cleaned.includes(",")) {
        cleaned = cleaned.replace(",", ".");
    }

    if (!cleaned) {
        return null;
    }

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
}

/** "https://schema.org/InStock" → "InStock". */
function enumName(value: unknown): string | null {
    const raw = text(value);
    return raw ? raw.replace(/^https?:\/\/schema\.org\//, "") : null;
}

function imageUrls(value: unknown): string[] {
    return asArray(value)
        .map((image) => (isObject(image) ? (text(image.contentUrl) ?? text(image.url)) : text(image)))
        .filter((url): url is string => url !== null)
        .slice(0, MAX_IMAGES);
}

function readOffer(node: JsonObject): JsonLdOffer {
    const spec = asArray(node.priceSpecification).find(isObject);
    return {
        seller: text(node.seller) ?? text(node.offeredBy),
        price: parsePrice(node.price) ?? parsePrice(spec?.price) ?? parsePrice(node.lowPrice),
        currency: text(node.priceCurrency) ?? text(spec?.priceCurrency),
        availability: enumName(node.availability),
        condition: enumName(node.itemCondition),
        url: text(node.url),
    };
}

function readOffers(value: unknown): Pick<JsonLdProduct, "offers" | "priceRange"> {
    const offers: JsonLdOffer[] = [];
    let priceRange: JsonLdProduct["priceRange"] = null;

    for (const node of asArray(value).filter(isObject)) {
        if (typesOf(node).includes("AggregateOffer")) {
            priceRange = {
                low: parsePrice(node.lowPrice) ?? parsePrice(node.price),
                high: parsePrice(node.highPrice),
                currency: text(node.priceCurrency),
                offerCount: parsePrice(node.offerCount),
            };
            offers.push(...asArray(node.offers).filter(isObject).map(readOffer));
            continue;
        }

        offers.push(readOffer(node));
    }

    if (!priceRange && offers.length > 0) {
        const prices = offers.map((offer) => offer.price).filter((price): price is number => price !== null);
        const currencies = new Set(offers.map((offer) => offer.currency).filter((currency) => currency !== null));
        priceRange = {
            low: prices.length > 0 ? Math.min(...prices) : null,
            high: prices.length > 0 ? Math.max(...prices) : null,
            currency: currencies.size === 1 ? [...currencies][0] : null,
            offerCount: offers.length,
        };
    }

    return { offers, priceRange };
}

function readRating(value: unknown): JsonLdRating | null {
    const node = asArray(value).find(isObject);
    if (!node) {
        return null;
    }

    return {
        value: parsePrice(node.ratingValue),
        best: parsePrice(node.bestRating),
        worst: parsePrice(node.worstRating),
        ratingCount: parsePrice(node.ratingCount),
        reviewCount: parsePrice(node.reviewCount),
    };
}

function readProduct(node: JsonObject, type: string): JsonLdProduct {
    const description = text(node.description);
    return {
        type,
        name: text(node.name),
        brand: text(node.brand) ?? text(node.manufacturer),
        sku: text(node.sku) ?? text(node.productID),
        gtin: text(node.gtin13) ?? text(node.gtin) ?? text(node.gtin12) ?? text(node.gtin14) ?? text(node.gtin8),
        mpn: text(node.mpn),
        url: text(node.url),
        category: text(node.category),
        description:
            description && description.length > DESCRIPTION_CHARS
                ? `${description.slice(0, DESCRIPTION_CHARS)}…`
                : description,
        images: imageUrls(node.image),
        rating: readRating(node.aggregateRating),
        ...readOffers(node.offers),
        properties: asArray(node.additionalProperty)
            .filter(isObject)
            .map((property) => ({ name: text(property.name), value: text(property.value) }))
            .filter(
                (property): property is { name: string; value: string } =>
                    property.name !== null && property.value !== null
            ),
    };
}

function readBreadcrumbs(node: JsonObject): JsonLdCrumb[] {
    return asArray(node.itemListElement)
        .filter(isObject)
        .map((element) => {
            const item = element.item;
            return {
                position: parsePrice(element.position),
                name: text(element.name) ?? (isObject(item) ? text(item.name) : null),
                url: typeof item === "string" ? item : isObject(item) ? (text(item["@id"]) ?? text(item.url)) : null,
            };
        })
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/** The parsed top-level nodes of every JSON-LD block, with `@graph` arrays and top-level arrays flattened. */
export function readJsonLdNodes(html: string): { nodes: JsonObject[]; blocks: number; parseErrors: number } {
    const nodes: JsonObject[] = [];
    let blocks = 0;
    let parseErrors = 0;

    for (const match of html.matchAll(SCRIPT_RE)) {
        blocks++;
        const source = match[1]
            .trim()
            .replace(/^<!--|-->$/g, "")
            .replace(/^\/\*<!\[CDATA\[\*\/|\/\*\]\]>\*\/$/g, "");
        let parsed: unknown;
        try {
            parsed = SafeJSON.parse(source);
        } catch (error) {
            parseErrors++;
            logger.debug({ error, start: source.slice(0, 120) }, "fetch: a JSON-LD block did not parse");
            continue;
        }

        const queue = asArray(parsed);
        while (queue.length > 0) {
            const node = queue.shift();
            if (Array.isArray(node)) {
                queue.push(...node);
                continue;
            }

            if (!isObject(node)) {
                continue;
            }

            if (node["@graph"] !== undefined) {
                queue.push(...asArray(node["@graph"]));
            }

            if (node["@type"] !== undefined) {
                nodes.push(node);
            }
        }
    }

    return { nodes, blocks, parseErrors };
}

/** Products, breadcrumbs and a list of the other typed nodes from a page's JSON-LD. A page without any gives empty lists. */
export function extractJsonLd(html: string): JsonLdData {
    const { nodes, blocks, parseErrors } = readJsonLdNodes(html);
    const data: JsonLdData = { blocks, parseErrors, products: [], breadcrumbs: [], other: [] };

    for (const node of nodes) {
        const types = typesOf(node);
        const productType = types.find((type) => PRODUCT_TYPES.has(type));
        if (productType) {
            data.products.push(readProduct(node, productType));
            continue;
        }

        if (types.includes("BreadcrumbList")) {
            data.breadcrumbs.push(readBreadcrumbs(node));
            continue;
        }

        data.other.push({ type: types.join(",") || "unknown", name: text(node.name) ?? text(node.headline) });
    }

    return data;
}
