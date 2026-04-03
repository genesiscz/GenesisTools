import { parseOptionalNumber, parsePeriod, resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import type { AnalysisFilters, ProviderName } from "@app/Internal/commands/reas/types";

export type FetchableListingType = "sale" | "rental" | "sold";

export interface ListingsFetchInput {
    type: FetchableListingType;
    district: string;
    constructionType: string;
    disposition?: string;
    source?: string;
    priceMin?: string;
    priceMax?: string;
    areaMin?: string;
    areaMax?: string;
}

const LISTING_FETCH_PROVIDERS: Record<FetchableListingType, ProviderName[]> = {
    sale: ["sreality", "bezrealitky"],
    rental: ["sreality", "bezrealitky", "ereality"],
    sold: ["reas"],
};

export function buildListingsFetchFilters(input: ListingsFetchInput): AnalysisFilters {
    const districtName = input.district.trim();

    if (!districtName) {
        throw new Error("Select a district before fetching listings");
    }

    const supportedProviders = LISTING_FETCH_PROVIDERS[input.type];
    const selectedSource = input.source?.trim().toLowerCase();
    const providers = selectedSource ? supportedProviders.filter((provider) => provider === selectedSource) : undefined;
    const year = new Date().getFullYear();

    return {
        estateType: "flat",
        constructionType: input.constructionType,
        disposition: input.disposition && input.disposition !== "all" ? input.disposition : undefined,
        periods: [parsePeriod(String(year))],
        district: resolveDistrict(districtName),
        priceMin: parseOptionalNumber(input.priceMin),
        priceMax: parseOptionalNumber(input.priceMax),
        areaMin: parseOptionalNumber(input.areaMin),
        areaMax: parseOptionalNumber(input.areaMax),
        providers,
    };
}
