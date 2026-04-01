import { analyzeComparables } from "@app/Internal/commands/reas/analysis/comparables";
import { analyzeDiscount } from "@app/Internal/commands/reas/analysis/discount";
import { computeInvestmentScore } from "@app/Internal/commands/reas/analysis/investment-score";
import { detectMomentum } from "@app/Internal/commands/reas/analysis/market-momentum";
import { analyzeRentalYield } from "@app/Internal/commands/reas/analysis/rental-yield";
import { analyzeTimeOnMarket } from "@app/Internal/commands/reas/analysis/time-on-market";
import { analyzeTrends } from "@app/Internal/commands/reas/analysis/trends";
import { fetchMfRentalData } from "@app/Internal/commands/reas/api/mf-rental";
import { fetchSoldListings } from "@app/Internal/commands/reas/api/reas-client";
import { fetchRentalListings } from "@app/Internal/commands/reas/api/sreality-client";
import { parsePeriods, resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import type {
    AnalysisFilters,
    FullAnalysis,
    MfRentalBenchmark,
    ProviderName,
    ReasListing,
    SrealityRental,
    TargetProperty,
} from "@app/Internal/commands/reas/types";

export interface AnalysisProgress {
    phase: "fetching" | "analyzing" | "complete";
    message: string;
    warnings?: string[];
}

export type ProgressCallback = (progress: AnalysisProgress) => void;

export function isProviderEnabled(filters: AnalysisFilters, provider: ProviderName): boolean {
    return !filters.providers || filters.providers.includes(provider);
}

export function applyListingFilters(listings: ReasListing[], filters: AnalysisFilters): ReasListing[] {
    let result = listings;

    if (filters.priceMin !== undefined) {
        result = result.filter((l) => l.soldPrice >= filters.priceMin!);
    }

    if (filters.priceMax !== undefined) {
        result = result.filter((l) => l.soldPrice <= filters.priceMax!);
    }

    if (filters.areaMin !== undefined) {
        result = result.filter((l) => l.utilityArea >= filters.areaMin!);
    }

    if (filters.areaMax !== undefined) {
        result = result.filter((l) => l.utilityArea <= filters.areaMax!);
    }

    return result;
}

export interface FetchAndAnalyzeOptions {
    onProgress?: ProgressCallback;
    persistResult?: boolean;
}

export async function fetchAndAnalyze(
    filters: AnalysisFilters,
    target: TargetProperty,
    refresh: boolean,
    options?: FetchAndAnalyzeOptions
): Promise<FullAnalysis> {
    const onProgress = options?.onProgress;
    onProgress?.({ phase: "fetching", message: "Fetching data from all providers..." });

    const warnings: string[] = [];

    const [reasResult, srealityResult, mfResult] = await Promise.allSettled([
        isProviderEnabled(filters, "reas")
            ? (async () => {
                  const listings: ReasListing[] = [];
                  for (const period of filters.periods) {
                      listings.push(...(await fetchSoldListings(filters, period, refresh)));
                  }
                  return listings;
              })()
            : Promise.resolve([] as ReasListing[]),
        isProviderEnabled(filters, "sreality")
            ? fetchRentalListings(filters, refresh)
            : Promise.resolve([] as SrealityRental[]),
        isProviderEnabled(filters, "mf")
            ? fetchMfRentalData(filters.district.name, refresh)
            : Promise.resolve([] as MfRentalBenchmark[]),
    ]);

    let allListings: ReasListing[] = [];

    if (reasResult.status === "fulfilled") {
        allListings = reasResult.value;
    } else {
        warnings.push(
            `REAS: ${reasResult.reason instanceof Error ? reasResult.reason.message : String(reasResult.reason)}`
        );
    }

    allListings = applyListingFilters(allListings, filters);

    let rentalListings: SrealityRental[] = [];

    if (srealityResult.status === "fulfilled") {
        rentalListings = srealityResult.value;
    } else {
        warnings.push(
            `Sreality: ${srealityResult.reason instanceof Error ? srealityResult.reason.message : String(srealityResult.reason)}`
        );
    }

    let mfBenchmarks: MfRentalBenchmark[] = [];

    if (mfResult.status === "fulfilled") {
        mfBenchmarks = mfResult.value;
    } else {
        warnings.push(
            `MF cenova mapa: ${mfResult.reason instanceof Error ? mfResult.reason.message : String(mfResult.reason)}`
        );
    }

    onProgress?.({
        phase: "analyzing",
        message: `Data fetched: ${allListings.length} sold, ${rentalListings.length} rentals, ${mfBenchmarks.length} MF benchmarks.`,
        warnings: warnings.length > 0 ? warnings : undefined,
    });

    const comparables = analyzeComparables(allListings, target);
    const trends = analyzeTrends(allListings);
    const timeOnMarket = analyzeTimeOnMarket(allListings);
    const discount = analyzeDiscount(allListings);

    const matchingRentals = rentalListings.filter((r) => !filters.disposition || r.disposition === filters.disposition);

    const avgRent =
        matchingRentals.length > 0
            ? matchingRentals.reduce((sum, r) => sum + r.price, 0) / matchingRentals.length
            : target.monthlyRent;

    const yieldResult = analyzeRentalYield(target, comparables.pricePerM2.median, avgRent);

    const momentum = detectMomentum(
        trends.periods.map((period) => ({ medianPerM2: period.medianPerM2, count: period.count }))
    );

    const investmentScore = computeInvestmentScore({
        netYield: yieldResult.netYield,
        discount: discount.medianDiscount,
        trendDirection: trends.direction,
        trendYoY: trends.yoyChange ?? 0,
        medianDaysOnMarket: timeOnMarket.median,
        districtMedianDays: timeOnMarket.median,
    });

    const result: FullAnalysis = {
        comparables,
        trends,
        yield: yieldResult,
        timeOnMarket,
        discount,
        rentalListings,
        mfBenchmarks,
        target,
        filters,
        investmentScore,
        momentum,
    };

    if (options?.persistResult !== false) {
        try {
            reasDatabase.saveAnalysis(result);
            reasDatabase.saveDistrictSnapshot(result);
        } catch {
            // Non-fatal — persistence failure should not break analysis
        }
    }

    onProgress?.({
        phase: "complete",
        message: `Data fetched: ${allListings.length} sold, ${rentalListings.length} rentals, ${mfBenchmarks.length} MF benchmarks.`,
        warnings: warnings.length > 0 ? warnings : undefined,
    });

    return result;
}

export interface SearchListingsOptions {
    query: string;
    district?: string;
    periodsStr?: string;
    constructionType?: string;
    refresh?: boolean;
}

const SEARCH_DEFAULT_DISTRICT = "Hradec Králové";
const SEARCH_CONSTRUCTION_TYPES = ["panel", "brick"];

function getSearchDefaultPeriods(): string {
    const year = new Date().getFullYear();
    return `${year - 2},${year - 1},${year}`;
}

export async function searchListings(options: SearchListingsOptions): Promise<ReasListing[]> {
    const district = resolveDistrict(options.district ?? SEARCH_DEFAULT_DISTRICT);
    const periods = parsePeriods(options.periodsStr ?? getSearchDefaultPeriods());
    const constructionTypes = options.constructionType ? [options.constructionType] : SEARCH_CONSTRUCTION_TYPES;
    const refresh = !!options.refresh;
    const queryLower = options.query.toLowerCase();

    const allListings: ReasListing[] = [];

    for (const constructionType of constructionTypes) {
        const filters: AnalysisFilters = {
            estateType: "flat",
            constructionType,
            periods,
            district,
        };

        for (const period of periods) {
            const listings = await fetchSoldListings(filters, period, refresh);
            allListings.push(...listings);
        }
    }

    const matched = allListings.filter((l) => l.formattedAddress.toLowerCase().includes(queryLower));
    matched.sort((a, b) => new Date(b.soldAt).getTime() - new Date(a.soldAt).getTime());

    return matched;
}
