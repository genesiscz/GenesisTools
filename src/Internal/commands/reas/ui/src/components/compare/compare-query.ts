import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import type { ListingRow, SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";
import { PROPERTY_TYPES } from "@app/Internal/commands/reas/lib/config-builder";

const DEFAULT_COMPARE_STATE = {
    propertyType: "brick",
    disposition: "all",
    price: "5000000",
    area: "80",
} as const;

export const DEFAULT_COMPARE_DISTRICTS = [
    "Praha 1",
    "Praha 2",
    "Praha 3",
    "Praha 4",
    "Praha 5",
    "Praha 6",
    "Praha 7",
    "Praha 8",
    "Praha 9",
    "Praha 10",
] as const;

const VALID_PROPERTY_TYPES = new Set(PROPERTY_TYPES.map((type) => type.value));

function normalizeDistricts({ districts, maxDistricts }: { districts: string[]; maxDistricts?: number }) {
    const deduped = [...new Set(districts.map((district) => district.trim()).filter(Boolean))];

    if (maxDistricts === undefined) {
        return deduped;
    }

    return deduped.slice(0, maxDistricts);
}

function normalizePropertyType(propertyType: string | null | undefined) {
    if (!propertyType || !VALID_PROPERTY_TYPES.has(propertyType)) {
        return DEFAULT_COMPARE_STATE.propertyType;
    }

    return propertyType;
}

function normalizeNumberString(value: string | number | null | undefined, fallback: string) {
    if (value === null || value === undefined) {
        return fallback;
    }

    const normalized = typeof value === "number" ? String(Math.round(value)) : value.trim();

    if (!normalized) {
        return fallback;
    }

    return /^\d+$/.test(normalized) ? normalized : fallback;
}

export function buildCompareSearchParams({
    districts,
    propertyType,
    disposition,
    price,
    area,
}: {
    districts: string[];
    propertyType?: string;
    disposition?: string | null;
    price?: string | number | null;
    area?: string | number | null;
}) {
    const params = new URLSearchParams();
    const normalizedDistricts = normalizeDistricts({ districts });
    params.set("districts", normalizedDistricts.join(","));

    params.set("type", normalizePropertyType(propertyType));

    if (disposition && disposition !== "all") {
        params.set("disposition", disposition);
    }

    params.set("price", normalizeNumberString(price, DEFAULT_COMPARE_STATE.price));
    params.set("area", normalizeNumberString(area, DEFAULT_COMPARE_STATE.area));

    return params;
}

export function parseCompareSearchParams({ search, maxDistricts }: { search: string; maxDistricts: number }) {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const hasDistrictsParam = params.has("districts");
    const parsedDistricts = normalizeDistricts({
        districts: (params.get("districts") ?? "").split(","),
        maxDistricts,
    });

    return {
        districts:
            parsedDistricts.length > 0
                ? parsedDistricts
                : hasDistrictsParam
                  ? []
                  : DEFAULT_COMPARE_DISTRICTS.slice(0, maxDistricts),
        propertyType: normalizePropertyType(params.get("type")),
        disposition: params.get("disposition")?.trim() || DEFAULT_COMPARE_STATE.disposition,
        price: normalizeNumberString(params.get("price"), DEFAULT_COMPARE_STATE.price),
        area: normalizeNumberString(params.get("area"), DEFAULT_COMPARE_STATE.area),
    };
}

export function buildAnalysisCompareQuery(data: DashboardExport) {
    return buildCompareSearchParams({
        districts: [data.meta.target.district],
        propertyType: data.meta.target.constructionType,
        disposition: data.meta.target.disposition,
        price: data.meta.target.price,
        area: data.meta.target.area,
    });
}

export function buildListingCompareQuery(listing: ListingRow) {
    return buildCompareSearchParams({
        districts: [listing.district],
        propertyType: normalizePropertyType(listing.building_type),
        disposition: listing.disposition,
        price: listing.price,
        area: listing.area,
    });
}

export function buildWatchlistCompareQuery(properties: SavedPropertyRow[]) {
    const districts = properties.map((property) => property.district);
    const firstProperty = properties[0];
    const averagePrice = Math.round(
        properties.reduce((sum, property) => sum + property.target_price, 0) / (properties.length || 1)
    );
    const averageArea = Math.round(
        properties.reduce((sum, property) => sum + property.target_area, 0) / (properties.length || 1)
    );

    const params = buildCompareSearchParams({
        districts,
        propertyType: firstProperty?.construction_type,
        disposition: firstProperty?.disposition,
        price: averagePrice > 0 ? averagePrice : null,
        area: averageArea > 0 ? averageArea : null,
    });

    if (averagePrice <= 0) {
        params.delete("price");
    }

    if (averageArea <= 0) {
        params.delete("area");
    }

    return params;
}
