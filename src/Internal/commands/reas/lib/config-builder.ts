import type { DistrictInfo } from "@app/Internal/commands/reas/data/districts";
import { getAllDistrictNames, getDistrict, searchDistricts } from "@app/Internal/commands/reas/data/districts";
import type { AnalysisFilters, DateRange, ProviderName, TargetProperty } from "@app/Internal/commands/reas/types";

export const PROPERTY_TYPES: Array<{ value: string; label: string }> = [
    { value: "panel", label: "Panel" },
    { value: "brick", label: "Brick" },
    { value: "house", label: "House" },
];

export const DISPOSITIONS: Array<{ value: string; label: string }> = [
    { value: "1+1", label: "1+1" },
    { value: "1+kk", label: "1+kk" },
    { value: "2+1", label: "2+1" },
    { value: "2+kk", label: "2+kk" },
    { value: "3+1", label: "3+1" },
    { value: "3+kk", label: "3+kk" },
    { value: "4+1", label: "4+1" },
    { value: "4+kk", label: "4+kk" },
    { value: "all", label: "All" },
];

export function buildPeriodOptions(): Array<{ value: string; label: string }> {
    const year = new Date().getFullYear();
    return [
        { value: String(year), label: String(year) },
        { value: String(year - 1), label: String(year - 1) },
        { value: String(year - 2), label: String(year - 2) },
        { value: "last6m", label: "Last 6 months" },
    ];
}

export function parsePeriod(period: string): DateRange {
    const relativeMatch = /^last(\d+)m$/i.exec(period);

    if (relativeMatch) {
        const months = parseInt(relativeMatch[1], 10);
        const now = new Date();
        const from = new Date(now);
        from.setMonth(from.getMonth() - months);

        return {
            label: `Last ${months} months`,
            from,
            to: now,
        };
    }

    const year = parseInt(period, 10);

    if (Number.isNaN(year)) {
        throw new Error(`Invalid period: "${period}". Expected a year (e.g. 2024), "last6m", "last12m", etc.`);
    }

    return {
        label: String(year),
        from: new Date(`${year}-01-01T00:00:00`),
        to: new Date(`${year}-12-31T23:59:59`),
    };
}

export function parsePeriods(periodsStr: string | undefined): DateRange[] {
    if (!periodsStr) {
        const currentYear = new Date().getFullYear();
        return [parsePeriod(String(currentYear))];
    }

    return periodsStr.split(",").map((s) => parsePeriod(s.trim()));
}

export function resolveDistrict(name: string): DistrictInfo {
    const exact = getDistrict(name);

    if (exact) {
        return exact;
    }

    const matches = searchDistricts(name);

    if (matches.length === 1) {
        return matches[0];
    }

    if (matches.length > 1) {
        throw new Error(`Ambiguous district "${name}". Matches: ${matches.map((d) => d.name).join(", ")}`);
    }

    throw new Error(`Unknown district: "${name}". Use --district with one of: ${getAllDistrictNames().join(", ")}`);
}

export function parseOptionalNumber(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
}

export function parseProviders(raw: string | undefined): ProviderName[] | undefined {
    if (!raw) {
        return undefined;
    }

    const valid = new Set<ProviderName>(["reas", "sreality", "ereality", "bezrealitky", "mf"]);
    const tokens = raw.split(",").map((s) => s.trim().toLowerCase());
    const unknown = tokens.filter((t) => !valid.has(t as ProviderName));

    if (unknown.length > 0) {
        throw new Error(`Unknown provider(s): ${unknown.join(", ")}. Valid: ${[...valid].join(", ")}`);
    }

    return tokens.filter((name): name is ProviderName => valid.has(name as ProviderName));
}

export interface BuildConfigOptions {
    district: DistrictInfo;
    constructionType: string;
    disposition?: string;
    periodsStr?: string;
    price: number;
    area: number;
    rent?: number;
    monthlyCosts?: number;
    priceMin?: string;
    priceMax?: string;
    areaMin?: string;
    areaMax?: string;
    providers?: string;
}

export function buildConfig(options: BuildConfigOptions): { filters: AnalysisFilters; target: TargetProperty } {
    const disposition = options.disposition && options.disposition !== "all" ? options.disposition : undefined;
    const dateRanges = parsePeriods(options.periodsStr);

    const filters: AnalysisFilters = {
        estateType: "flat",
        constructionType: options.constructionType,
        disposition,
        periods: dateRanges,
        district: options.district,
        priceMin: parseOptionalNumber(options.priceMin),
        priceMax: parseOptionalNumber(options.priceMax),
        areaMin: parseOptionalNumber(options.areaMin),
        areaMax: parseOptionalNumber(options.areaMax),
        providers: parseProviders(options.providers),
    };

    const target: TargetProperty = {
        price: options.price,
        area: options.area,
        disposition: disposition ?? "all",
        constructionType: options.constructionType,
        monthlyRent: options.rent ?? 0,
        monthlyCosts: options.monthlyCosts ?? 0,
        district: options.district.name,
        districtId: options.district.reasId,
        srealityDistrictId: options.district.srealityId,
    };

    return { filters, target };
}

export function hasSufficientFlags(options: {
    district?: string;
    address?: string;
    type?: string;
    price?: string;
    area?: string;
}): boolean {
    return !!((options.district || options.address) && options.type && options.price && options.area);
}
