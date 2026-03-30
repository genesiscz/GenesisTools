import { cacheKey, getCached, SREALITY_TTL, setCache } from "../cache/index";
import type { AnalysisFilters, CacheEntry } from "../types";

const BASE_URL = "https://www.ereality.cz/pronajem/byty";
const PER_PAGE = 24;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";
const CRAWL_DELAY_MS = 2000;

const NAME_REGEX = /Pron[aá]jem\s+bytu\s+(\d\+(?:kk|\d))\s+(\d+)\s*m/i;

export interface ErealityListing {
    heading: string;
    locality: string;
    price: number;
    disposition: string;
    area: number;
    link: string;
}

export function buildErealityUrl(districtSlug: string, page: number): string {
    return `${BASE_URL}/${districtSlug}?pg=${page}`;
}

/**
 * Parse eReality HTML to extract rental listing tiles.
 * Tiles with unparseable prices (e.g. "Cena na vyžádání") are skipped.
 */
export function parseErealityHtml(html: string): ErealityListing[] {
    const listings: ErealityListing[] = [];

    const tileRegex =
        /<div[^>]*class="[^"]*ereality-property-tile[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*ereality-property-tile|$)/g;

    for (const tileMatch of html.matchAll(tileRegex)) {
        const tile = tileMatch[0];

        const headingMatch = /<strong[^>]*class="[^"]*ereality-property-heading[^"]*"[^>]*>([\s\S]*?)<\/strong>/i.exec(
            tile
        );
        const localityMatch = /<p[^>]*class="[^"]*ereality-property-locality[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(tile);
        const priceMatch = /<div[^>]*class="[^"]*ereality-property-price[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(tile);
        const linkMatch = /<a[^>]*href="([^"]*)"[^>]*class="[^"]*ereality-property-description[^"]*"/i.exec(tile);

        if (!headingMatch || !priceMatch) {
            continue;
        }

        const heading = headingMatch[1].trim();
        const locality = localityMatch ? localityMatch[1].trim() : "";
        const priceText = priceMatch[1].trim();

        // Extract numeric price: "18 000 Kč/měsíc" → 18000
        const priceDigits = priceText.replace(/[^\d]/g, "");

        if (!priceDigits) {
            continue;
        }

        const price = Number(priceDigits);

        if (Number.isNaN(price) || price === 0) {
            continue;
        }

        // Extract disposition and area from heading
        const nameMatch = NAME_REGEX.exec(heading);
        const disposition = nameMatch ? nameMatch[1] : "";
        const area = nameMatch ? Number(nameMatch[2]) : 0;

        const link = linkMatch ? `https://www.ereality.cz${linkMatch[1]}` : "";

        listings.push({
            heading,
            locality,
            price,
            disposition,
            area,
            link,
        });
    }

    return listings;
}

/**
 * Extract total listing count from the results header.
 * Looks for pattern like "(264 inzerátů)" in the page.
 */
export function extractTotalCount(html: string): number | null {
    const match = /\((\d+)\s*inzerát/i.exec(html);

    if (!match) {
        return null;
    }

    return Number(match[1]);
}

function buildCacheKeyParams(filters: AnalysisFilters): Record<string, unknown> {
    return {
        source: "ereality",
        districtName: filters.district.name,
        disposition: filters.disposition ?? null,
    };
}

function getErealitySlug(districtName: string): string {
    return districtName
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
}

/**
 * Fetch rental listings from eReality via HTML scraping.
 * Pages are 0-indexed, 24 listings per page.
 * Rate-limited to 1 request per 2 seconds (robots.txt crawl-delay).
 */
export async function fetchErealityRentals(filters: AnalysisFilters, refresh = false): Promise<ErealityListing[]> {
    const keyParams = buildCacheKeyParams(filters);
    const key = cacheKey(keyParams);

    if (!refresh) {
        const cached = await getCached<ErealityListing>(key, SREALITY_TTL);

        if (cached) {
            return cached.data;
        }
    }

    const slug = getErealitySlug(filters.district.name);
    const allListings: ErealityListing[] = [];
    let page = 0;
    let totalCount = Number.POSITIVE_INFINITY;

    while (page * PER_PAGE < totalCount) {
        const url = buildErealityUrl(slug, page);

        const response = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
        });

        if (!response.ok) {
            if (response.status === 404) {
                break;
            }

            throw new Error(`eReality fetch error (page ${page}): ${response.status} ${response.statusText}`);
        }

        const html = await response.text();

        // Try to extract total count from first page
        if (page === 0) {
            const count = extractTotalCount(html);

            if (count !== null) {
                totalCount = count;
            }
        }

        const pageListings = parseErealityHtml(html);
        allListings.push(...pageListings);

        if (pageListings.length === 0) {
            break;
        }

        page++;

        // Rate limit: respect robots.txt crawl-delay of 2s
        if (page * PER_PAGE < totalCount) {
            await new Promise((resolve) => setTimeout(resolve, CRAWL_DELAY_MS));
        }
    }

    // Filter by disposition client-side if specified
    const filtered = filters.disposition
        ? allListings.filter((l) => l.disposition === filters.disposition)
        : allListings;

    const entry: CacheEntry<ErealityListing> = {
        fetchedAt: new Date().toISOString(),
        params: keyParams,
        count: filtered.length,
        data: filtered,
    };

    await setCache(key, entry);

    return filtered;
}
