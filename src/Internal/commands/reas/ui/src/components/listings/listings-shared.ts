import type { GetListingsOptions, ListingRow } from "@app/Internal/commands/reas/lib/store";

export type ListingType = "sale" | "rental" | "sold";
export type SortBy = NonNullable<GetListingsOptions["sortBy"]>;
export type SortDir = NonNullable<GetListingsOptions["sortDir"]>;

export interface ListingsFilters {
    district: string;
    dispositions: string[];
    sources: string[];
    priceMin: string;
    priceMax: string;
    areaMin: string;
    areaMax: string;
    seenFrom: string;
    seenTo: string;
}

export interface ListingsResponse {
    listings: ListingRow[];
    overview: {
        saleCount: number;
        rentalCount: number;
        soldCount: number;
        saleLastFetchedAt: string | null;
        rentalLastFetchedAt: string | null;
        soldLastFetchedAt: string | null;
        lastFetchedAt: string | null;
        sourceCount: number;
        sources: Array<{
            source: string;
            count: number;
            lastFetchedAt: string | null;
        }>;
    };
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

export const DEFAULT_FILTERS: ListingsFilters = {
    district: "",
    dispositions: [],
    sources: [],
    priceMin: "",
    priceMax: "",
    areaMin: "",
    areaMax: "",
    seenFrom: "",
    seenTo: "",
};

export const LISTING_TYPES: Array<{ value: ListingType; label: string }> = [
    { value: "sale", label: "Sale" },
    { value: "rental", label: "Rental" },
    { value: "sold", label: "Sold" },
];

export const SORT_OPTIONS: Array<{ value: SortBy; label: string }> = [
    { value: "fetched_at", label: "Fetched at" },
    { value: "sold_at", label: "Sold at" },
    { value: "price", label: "Price" },
    { value: "price_per_m2", label: "Price / m2" },
    { value: "area", label: "Area" },
];

export const LISTING_SKELETON_KEYS = ["one", "two", "three", "four", "five", "six", "seven", "eight"] as const;

export function appendFilterParams(params: URLSearchParams, filters: ListingsFilters) {
    const normalized = normalizeFilters(filters);

    for (const [key, value] of Object.entries(normalized)) {
        if (Array.isArray(value)) {
            if (value.length > 0) {
                params.set(key, value.join(","));
            }

            continue;
        }

        if (value) {
            params.set(key, value);
        }
    }
}

export function normalizeFilters(filters: ListingsFilters): ListingsFilters {
    return {
        district: filters.district.trim(),
        dispositions: filters.dispositions.map((value) => value.trim()).filter(Boolean),
        sources: filters.sources.map((value) => value.trim()).filter(Boolean),
        priceMin: filters.priceMin.trim(),
        priceMax: filters.priceMax.trim(),
        areaMin: filters.areaMin.trim(),
        areaMax: filters.areaMax.trim(),
        seenFrom: filters.seenFrom.trim(),
        seenTo: filters.seenTo.trim(),
    };
}

export function countActiveFilters(filters: ListingsFilters) {
    const normalized = normalizeFilters(filters);
    let count = 0;

    if (normalized.district) {
        count += 1;
    }

    if (normalized.dispositions.length > 0) {
        count += 1;
    }

    if (normalized.sources.length > 0) {
        count += 1;
    }

    if (normalized.priceMin) {
        count += 1;
    }

    if (normalized.priceMax) {
        count += 1;
    }

    if (normalized.areaMin) {
        count += 1;
    }

    if (normalized.areaMax) {
        count += 1;
    }

    if (normalized.seenFrom || normalized.seenTo) {
        count += 1;
    }

    return count;
}

export function readableSortLabel(sortBy: SortBy) {
    return SORT_OPTIONS.find((option) => option.value === sortBy)?.label.toLowerCase() ?? sortBy;
}

export function formatPrice(value: number) {
    return `${value.toLocaleString("cs-CZ")} CZK`;
}

export function formatPricePerM2(value: number | null) {
    if (value === null) {
        return "--";
    }

    return `${value.toLocaleString("cs-CZ")} CZK`;
}

export function formatArea(value: number | null) {
    if (value === null) {
        return "--";
    }

    return `${value.toLocaleString("cs-CZ")} m2`;
}

export function formatMarketMetric(value: number | null) {
    if (value === null) {
        return "--";
    }

    return `${Math.round(value)} d`;
}

export function formatShortDate(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("cs-CZ", {
        dateStyle: "medium",
    }).format(new Date(value));
}

export function formatShortDateTime(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("cs-CZ", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));
}

export function getListingRangeLabel({ page, limit, total }: { page: number; limit: number; total: number }) {
    if (total <= 0) {
        return "Showing 0 of 0";
    }

    const start = (page - 1) * limit + 1;
    const end = Math.min(page * limit, total);

    return `Showing ${start} - ${end} of ${total}`;
}
