import { cacheKey, getCached, SREALITY_TTL, setCache } from "@app/Internal/commands/reas/cache/index";
import { matchesRequestedDistrict } from "@app/Internal/commands/reas/lib/district-matching";
import type { AnalysisFilters, CacheEntry, RentalListing } from "@app/Internal/commands/reas/types";
import { ApiClient, ApiClientError } from "@app/utils/api/ApiClient";
import type { ErealityListing } from "./ErealityClient.types";

const BASE_URL = "https://www.ereality.cz/pronajem/byty";
const PER_PAGE = 24;
const MAX_PAGES = 20;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";
const CRAWL_DELAY_MS = 2000;

const NAME_REGEX_OLD = /Pron[aá]jem\s+(?:luxusn[ií]ho\s+)?bytu\s+(\d\+(?:kk|\d))[,\s]+(\d+)\s*m/i;
const NAME_REGEX_NEW = /Byt\s+(\d\+(?:kk|\d))\s+k\s+pron[aá]jmu/i;

export function buildErealityUrl(districtSlug: string, page: number): string {
    return `${BASE_URL}/${districtSlug}?pg=${page}`;
}

export function parseErealityHtml(html: string): ErealityListing[] {
    const listings: ErealityListing[] = [];

    const tileRegex =
        /<(?:div|li)[^>]*class="[^"]*ereality-property-tile[^"]*"[^>]*>([\s\S]*?)(?=<(?:div|li)[^>]*class="[^"]*ereality-property-tile|$)/g;

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
        const priceDigits = priceText.replace(/[^\d]/g, "");

        if (!priceDigits) {
            continue;
        }

        const price = Number(priceDigits);

        if (Number.isNaN(price) || price === 0) {
            continue;
        }

        const oldMatch = NAME_REGEX_OLD.exec(heading);
        const newMatch = NAME_REGEX_NEW.exec(heading);
        const disposition = oldMatch ? oldMatch[1] : newMatch ? newMatch[1] : "";
        const area = oldMatch ? Number(oldMatch[2]) : 0;
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

function mapRentalListing(listing: ErealityListing): RentalListing {
    return {
        id: `ereality-${listing.link || listing.heading}`,
        source: "ereality",
        sourceId: listing.link || listing.heading,
        sourceContract: "ereality-html",
        type: "rental",
        name: listing.heading,
        price: listing.price,
        locality: listing.locality,
        disposition: listing.disposition || undefined,
        area: listing.area || undefined,
        link: listing.link,
        labels: [],
        rawData: listing,
    };
}

export class ErealityClient {
    private readonly apiClient = new ApiClient({
        loggerContext: { provider: "ereality" },
        userAgent: USER_AGENT,
    });

    buildUrl(districtSlug: string, page: number): string {
        return buildErealityUrl(districtSlug, page);
    }

    parseHtml(html: string): ErealityListing[] {
        return parseErealityHtml(html);
    }

    extractTotalCount(html: string): number | null {
        return extractTotalCount(html);
    }

    async fetchRentals(filters: AnalysisFilters, refresh = false): Promise<RentalListing[]> {
        const keyParams = buildCacheKeyParams(filters);
        const key = cacheKey(keyParams);

        if (!refresh) {
            const cached = await getCached<RentalListing>(key, SREALITY_TTL);

            if (cached) {
                return cached.data;
            }
        }

        const slug = getErealitySlug(filters.district.name);
        const allListings: RentalListing[] = [];
        let page = 0;
        let totalCount = Number.POSITIVE_INFINITY;

        while (page * PER_PAGE < totalCount && page < MAX_PAGES) {
            const url = this.buildUrl(slug, page);
            let html: string;

            try {
                html = await this.apiClient.getText(url);
            } catch (error) {
                if (error instanceof ApiClientError && error.status === 404) {
                    break;
                }

                if (error instanceof ApiClientError) {
                    throw new Error(`eReality fetch error (page ${page}): ${error.status} ${error.statusText}`);
                }

                throw error;
            }

            if (page === 0) {
                const count = this.extractTotalCount(html);

                if (count !== null) {
                    totalCount = count;
                }
            }

            const pageListings = this.parseHtml(html).map(mapRentalListing);
            allListings.push(...pageListings);

            if (pageListings.length === 0) {
                break;
            }

            page++;

            if (page * PER_PAGE < totalCount) {
                await new Promise((resolve) => setTimeout(resolve, CRAWL_DELAY_MS));
            }
        }

        const filtered = filters.disposition
            ? allListings.filter((listing) => listing.disposition === filters.disposition)
            : allListings;

        const districtFiltered = filtered.filter((listing) =>
            matchesRequestedDistrict({ requestedDistrict: filters.district.name, locality: listing.locality })
        );

        const entry: CacheEntry<RentalListing> = {
            fetchedAt: new Date().toISOString(),
            params: keyParams,
            count: districtFiltered.length,
            data: districtFiltered,
        };

        await setCache(key, entry);

        return districtFiltered;
    }
}

export const erealityClient = new ErealityClient();
