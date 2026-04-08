import { analyzeActiveVsSold } from "@app/Internal/commands/reas/analysis/active-vs-sold";
import { configureLogger } from "@app/logger";

// Enable file logging at debug level so all outbound API calls (logged by ApiClient) are captured
configureLogger({ logToFile: true, level: "debug" });

import { analyzeComparables } from "@app/Internal/commands/reas/analysis/comparables";
import { analyzeDiscount } from "@app/Internal/commands/reas/analysis/discount";
import { computeInvestmentScore } from "@app/Internal/commands/reas/analysis/investment-score";
import { detectMomentum } from "@app/Internal/commands/reas/analysis/market-momentum";
import { aggregateRentals } from "@app/Internal/commands/reas/analysis/rental-aggregation";
import { analyzeRentalYield } from "@app/Internal/commands/reas/analysis/rental-yield";
import { analyzeTimeOnMarket } from "@app/Internal/commands/reas/analysis/time-on-market";
import { analyzeTrends } from "@app/Internal/commands/reas/analysis/trends";
import { fetchBezrealitkyRentals, fetchBezrealitkySales } from "@app/Internal/commands/reas/api/bezrealitky-client";
import { fetchErealityRentals } from "@app/Internal/commands/reas/api/ereality-client";
import { fetchMfRentalDataForDistrict } from "@app/Internal/commands/reas/api/mf-rental";
import { fetchSoldListings } from "@app/Internal/commands/reas/api/reas-client";
import { fetchRentalListings, fetchSaleListings } from "@app/Internal/commands/reas/api/sreality-client";
import { parsePeriods, resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import { getListingPersistenceDistrict } from "@app/Internal/commands/reas/lib/district-matching";
import {
    buildListingsFetchFilters,
    type FetchableListingType,
    type ListingsFetchInput,
} from "@app/Internal/commands/reas/lib/listings-fetch";
import { reasDatabase, type UpsertListingInput } from "@app/Internal/commands/reas/lib/store";
import type {
    AnalysisFilters,
    FullAnalysis,
    MfRentalBenchmark,
    ProviderFetchSummary,
    ProviderName,
    ReasListing,
    RentalListing,
    SaleListing,
    TargetProperty,
} from "@app/Internal/commands/reas/types";
import { SafeJSON } from "@app/utils/json";

/** Minimum rental price to filter garbage entries (e.g. 1 CZK placeholder listings) */
const MIN_RENTAL_PRICE = 1000;

function buildProviderSummary({
    provider,
    sourceContract,
    count,
    error,
    district,
}: {
    provider: ProviderName;
    sourceContract: string;
    count: number;
    error?: string;
    district?: string;
}): ProviderFetchSummary {
    const status = error ? "error" : count === 0 ? "empty" : "success";

    try {
        reasDatabase.logProviderFetch({
            provider,
            sourceContract,
            district,
            status,
            listingCount: count,
            errorMessage: error,
        });
    } catch {
        // Non-fatal — logging failure must not break analysis
    }

    return {
        provider,
        sourceContract,
        count,
        fetchedAt: new Date().toISOString(),
        error,
    };
}

function buildPersistedListings({
    districtName,
    fetchedAt,
    soldListings,
    saleListings,
    rentalListings,
}: {
    districtName: string;
    fetchedAt: string;
    soldListings: ReasListing[];
    saleListings: SaleListing[];
    rentalListings: RentalListing[];
}): UpsertListingInput[] {
    const persistedSoldListings = soldListings.map((listing) => ({
        source: "reas",
        sourceContract: "reas-catalog",
        type: "sold" as const,
        status: "sold" as const,
        sourceId: listing._id,
        district: getListingPersistenceDistrict({
            requestedDistrict: districtName,
            locality: [
                listing.formattedAddress,
                listing.formattedLocation,
                listing.cadastralAreaSlug,
                listing.municipalitySlug,
            ].join(" "),
        }),
        disposition: listing.disposition,
        area: listing.utilityArea || listing.displayArea,
        price: listing.soldPrice,
        pricePerM2: listing.pricePerM2,
        address: listing.formattedAddress,
        link: listing.link,
        fetchedAt,
        soldAt: listing.soldAt,
        daysOnMarket: listing.daysOnMarket,
        discount: listing.discount,
        coordinatesLat: listing.point.coordinates[1],
        coordinatesLng: listing.point.coordinates[0],
        rawJson: SafeJSON.stringify(listing),
    }));

    const persistedSaleListings = saleListings.map((listing) => ({
        source: listing.source,
        sourceContract: listing.sourceContract,
        type: "sale" as const,
        status: "active" as const,
        sourceId: listing.sourceId,
        district: getListingPersistenceDistrict({ requestedDistrict: districtName, locality: listing.address }),
        disposition: listing.disposition,
        area: listing.area,
        price: listing.price,
        pricePerM2: listing.pricePerM2,
        address: listing.address,
        link: listing.link,
        fetchedAt,
        coordinatesLat: listing.coordinates?.lat,
        coordinatesLng: listing.coordinates?.lng,
        description: listing.description,
        rawJson: SafeJSON.stringify(listing.rawData ?? listing),
    }));

    const persistedRentalListings = rentalListings.map((listing) => ({
        source: listing.source,
        sourceContract: listing.sourceContract,
        type: "rental" as const,
        status: "active" as const,
        sourceId: listing.sourceId,
        district: getListingPersistenceDistrict({ requestedDistrict: districtName, locality: listing.locality }),
        disposition: listing.disposition,
        area: listing.area,
        price: listing.price,
        pricePerM2: listing.area ? listing.price / listing.area : undefined,
        address: listing.locality,
        link: listing.link ?? "",
        fetchedAt,
        coordinatesLat: listing.coordinates?.lat ?? listing.gps?.lat,
        coordinatesLng: listing.coordinates?.lng ?? listing.gps?.lon,
        description: listing.description,
        rawJson: SafeJSON.stringify(listing.rawData ?? listing),
    }));

    return [...persistedSoldListings, ...persistedSaleListings, ...persistedRentalListings];
}

/** Strip diacritics for accent-insensitive matching (e.g. "Letňany" → "Letnany") */
function stripDiacritics(str: string): string {
    return str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

export interface AnalysisProgress {
    phase: "fetching" | "analyzing" | "complete";
    message: string;
    warnings?: string[];
}

export type ProgressCallback = (progress: AnalysisProgress) => void;

interface ListingsSnapshotTarget {
    type: FetchableListingType;
    source: ProviderName;
    sourceContract: string;
}

type ListingsSnapshotSuccessKey = `${ProviderName}:${FetchableListingType}`;

type ListingsSnapshotSuccess = Partial<Record<ListingsSnapshotSuccessKey, boolean>>;

function buildSnapshotTarget(
    type: FetchableListingType,
    source: ProviderName,
    sourceContract: string
): ListingsSnapshotTarget {
    return {
        type,
        source,
        sourceContract,
    };
}

export function buildListingsSnapshotTargets({
    filters,
    listingType,
}: {
    filters: AnalysisFilters;
    listingType?: FetchableListingType;
}): ListingsSnapshotTarget[] {
    const targets: ListingsSnapshotTarget[] = [];

    if ((!listingType || listingType === "sold") && isProviderEnabled(filters, "reas")) {
        targets.push(buildSnapshotTarget("sold", "reas", "reas-catalog"));
    }

    if ((!listingType || listingType === "sale") && isProviderEnabled(filters, "sreality")) {
        targets.push(buildSnapshotTarget("sale", "sreality", "sreality-v2"));
    }

    if ((!listingType || listingType === "sale") && isProviderEnabled(filters, "bezrealitky")) {
        targets.push(buildSnapshotTarget("sale", "bezrealitky", "graphql:listAdverts:sale"));
    }

    if ((!listingType || listingType === "rental") && isProviderEnabled(filters, "sreality")) {
        targets.push(buildSnapshotTarget("rental", "sreality", "sreality-v2"));
    }

    if ((!listingType || listingType === "rental") && isProviderEnabled(filters, "bezrealitky")) {
        targets.push(buildSnapshotTarget("rental", "bezrealitky", "graphql:listAdverts"));
    }

    if ((!listingType || listingType === "rental") && isProviderEnabled(filters, "ereality")) {
        targets.push(buildSnapshotTarget("rental", "ereality", "ereality-html"));
    }

    return targets;
}

export function buildSuccessfulListingsSnapshotTargets({
    filters,
    listingType,
    providerSuccess,
}: {
    filters: AnalysisFilters;
    listingType?: FetchableListingType;
    providerSuccess: ListingsSnapshotSuccess;
}): ListingsSnapshotTarget[] {
    const requestedTargets = buildListingsSnapshotTargets({ filters, listingType });

    return requestedTargets.filter((target) => {
        const successKey: ListingsSnapshotSuccessKey = `${target.source}:${target.type}`;

        return providerSuccess[successKey] === true;
    });
}

function replaceListingsSnapshots({
    district,
    snapshotTargets,
}: {
    district: string;
    snapshotTargets: ListingsSnapshotTarget[];
}) {
    for (const target of snapshotTargets) {
        reasDatabase.replaceListingsSnapshot({
            district,
            type: target.type,
            source: target.source,
            sourceContract: target.sourceContract,
        });
    }
}

function repairListingSnapshots({
    district,
    snapshotTargets,
}: {
    district: string;
    snapshotTargets: ListingsSnapshotTarget[];
}) {
    reasDatabase.repairListingDistricts({
        district,
        types: [...new Set(snapshotTargets.map((target) => target.type))],
        sources: [...new Set(snapshotTargets.map((target) => target.source))],
    });
}

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

    const [
        reasResult,
        srealityRentalResult,
        srealitySaleResult,
        bezrealitkyRentalResult,
        bezrealitkySaleResult,
        erealityResult,
        mfResult,
    ] = await Promise.allSettled([
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
            : Promise.resolve([] as RentalListing[]),
        isProviderEnabled(filters, "sreality")
            ? fetchSaleListings(filters, refresh)
            : Promise.resolve([] as SaleListing[]),
        isProviderEnabled(filters, "bezrealitky")
            ? fetchBezrealitkyRentals(filters, refresh)
            : Promise.resolve([] as RentalListing[]),
        isProviderEnabled(filters, "bezrealitky")
            ? fetchBezrealitkySales(filters, refresh)
            : Promise.resolve([] as SaleListing[]),
        isProviderEnabled(filters, "ereality")
            ? fetchErealityRentals(filters, refresh)
            : Promise.resolve([] as RentalListing[]),
        isProviderEnabled(filters, "mf")
            ? fetchMfRentalDataForDistrict(filters.district.name, refresh)
            : Promise.resolve([] as MfRentalBenchmark[]),
    ]);

    const providerSummary: ProviderFetchSummary[] = [];
    const districtName = filters.district.name;

    function logProvider(input: { provider: ProviderName; sourceContract: string; count: number; error?: string }) {
        return buildProviderSummary({ ...input, district: districtName });
    }

    let allListings: ReasListing[] = [];

    if (reasResult.status === "fulfilled") {
        allListings = reasResult.value;
        providerSummary.push(
            logProvider({
                provider: "reas",
                sourceContract: "reas-catalog",
                count: allListings.length,
            })
        );
    } else {
        warnings.push(
            `REAS: ${reasResult.reason instanceof Error ? reasResult.reason.message : String(reasResult.reason)}`
        );
        providerSummary.push(
            logProvider({
                provider: "reas",
                sourceContract: "reas-catalog",
                count: 0,
                error: reasResult.reason instanceof Error ? reasResult.reason.message : String(reasResult.reason),
            })
        );
    }

    // Compute district-wide time-on-market before applying price/area filters,
    // so it serves as a broad baseline for the investment score velocity factor.
    const districtTimeOnMarket = analyzeTimeOnMarket(allListings);

    allListings = applyListingFilters(allListings, filters);

    const rentalListings: RentalListing[] = [];
    const saleListings: SaleListing[] = [];

    if (srealityRentalResult.status === "fulfilled") {
        const nextListings = srealityRentalResult.value.filter((listing) => listing.price >= MIN_RENTAL_PRICE);
        rentalListings.push(...nextListings);
        providerSummary.push(
            logProvider({
                provider: "sreality",
                sourceContract: "sreality-v2",
                count: nextListings.length,
            })
        );
    } else {
        warnings.push(
            `Sreality rentals: ${srealityRentalResult.reason instanceof Error ? srealityRentalResult.reason.message : String(srealityRentalResult.reason)}`
        );
        providerSummary.push(
            logProvider({
                provider: "sreality",
                sourceContract: "sreality-v2",
                count: 0,
                error:
                    srealityRentalResult.reason instanceof Error
                        ? srealityRentalResult.reason.message
                        : String(srealityRentalResult.reason),
            })
        );
    }

    if (srealitySaleResult.status === "fulfilled") {
        saleListings.push(...srealitySaleResult.value);
        providerSummary.push(
            logProvider({
                provider: "sreality",
                sourceContract: "sreality-v2-sale",
                count: srealitySaleResult.value.length,
            })
        );
    } else {
        warnings.push(
            `Sreality sales: ${srealitySaleResult.reason instanceof Error ? srealitySaleResult.reason.message : String(srealitySaleResult.reason)}`
        );
        providerSummary.push(
            logProvider({
                provider: "sreality",
                sourceContract: "sreality-v2-sale",
                count: 0,
                error:
                    srealitySaleResult.reason instanceof Error
                        ? srealitySaleResult.reason.message
                        : String(srealitySaleResult.reason),
            })
        );
    }

    if (bezrealitkyRentalResult.status === "fulfilled") {
        const nextListings = bezrealitkyRentalResult.value.filter((listing) => listing.price >= MIN_RENTAL_PRICE);
        rentalListings.push(...nextListings);
        providerSummary.push(
            logProvider({
                provider: "bezrealitky",
                sourceContract: "graphql:listAdverts",
                count: nextListings.length,
            })
        );
    } else {
        warnings.push(
            `Bezrealitky rentals: ${bezrealitkyRentalResult.reason instanceof Error ? bezrealitkyRentalResult.reason.message : String(bezrealitkyRentalResult.reason)}`
        );
        providerSummary.push(
            logProvider({
                provider: "bezrealitky",
                sourceContract: "graphql:listAdverts",
                count: 0,
                error:
                    bezrealitkyRentalResult.reason instanceof Error
                        ? bezrealitkyRentalResult.reason.message
                        : String(bezrealitkyRentalResult.reason),
            })
        );
    }

    if (bezrealitkySaleResult.status === "fulfilled") {
        saleListings.push(...bezrealitkySaleResult.value);
        providerSummary.push(
            logProvider({
                provider: "bezrealitky",
                sourceContract: "graphql:listAdverts:sale",
                count: bezrealitkySaleResult.value.length,
            })
        );
    } else {
        warnings.push(
            `Bezrealitky sales: ${bezrealitkySaleResult.reason instanceof Error ? bezrealitkySaleResult.reason.message : String(bezrealitkySaleResult.reason)}`
        );
        providerSummary.push(
            logProvider({
                provider: "bezrealitky",
                sourceContract: "graphql:listAdverts:sale",
                count: 0,
                error:
                    bezrealitkySaleResult.reason instanceof Error
                        ? bezrealitkySaleResult.reason.message
                        : String(bezrealitkySaleResult.reason),
            })
        );
    }

    if (erealityResult.status === "fulfilled") {
        const nextListings = erealityResult.value.filter((listing) => listing.price >= MIN_RENTAL_PRICE);
        rentalListings.push(...nextListings);
        providerSummary.push(
            logProvider({
                provider: "ereality",
                sourceContract: "ereality-html",
                count: nextListings.length,
            })
        );
    } else {
        warnings.push(
            `eReality rentals: ${erealityResult.reason instanceof Error ? erealityResult.reason.message : String(erealityResult.reason)}`
        );
        providerSummary.push(
            logProvider({
                provider: "ereality",
                sourceContract: "ereality-html",
                count: 0,
                error:
                    erealityResult.reason instanceof Error
                        ? erealityResult.reason.message
                        : String(erealityResult.reason),
            })
        );
    }

    let mfBenchmarks: MfRentalBenchmark[] = [];

    if (mfResult.status === "fulfilled") {
        mfBenchmarks = mfResult.value;
        providerSummary.push(
            logProvider({
                provider: "mf",
                sourceContract: "mf-cenova-mapa",
                count: mfBenchmarks.length,
            })
        );
    } else {
        warnings.push(
            `MF cenova mapa: ${mfResult.reason instanceof Error ? mfResult.reason.message : String(mfResult.reason)}`
        );
        providerSummary.push(
            logProvider({
                provider: "mf",
                sourceContract: "mf-cenova-mapa",
                count: 0,
                error: mfResult.reason instanceof Error ? mfResult.reason.message : String(mfResult.reason),
            })
        );
    }

    onProgress?.({
        phase: "analyzing",
        message: `Data fetched: ${allListings.length} sold, ${saleListings.length} active sales, ${rentalListings.length} rentals, ${mfBenchmarks.length} MF benchmarks.`,
        warnings: warnings.length > 0 ? warnings : undefined,
    });

    const comparables = analyzeComparables(allListings, target);
    const activeVsSold = analyzeActiveVsSold({
        activeListings: saleListings,
        soldListings: allListings,
    });
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
        districtMedianDays: districtTimeOnMarket.median,
    });

    const rentalAggregation = aggregateRentals([
        {
            provider: "sreality",
            listings: rentalListings
                .filter((listing) => listing.source === "sreality" && listing.disposition && listing.area)
                .map((listing) => ({
                    disposition: listing.disposition ?? "",
                    area: listing.area ?? 0,
                    rent: listing.price,
                    address: listing.locality,
                })),
        },
        {
            provider: "bezrealitky",
            listings: rentalListings
                .filter((listing) => listing.source === "bezrealitky" && listing.disposition && listing.area)
                .map((listing) => ({
                    disposition: listing.disposition ?? "",
                    area: listing.area ?? 0,
                    rent: listing.price,
                    address: listing.locality,
                })),
        },
        {
            provider: "ereality",
            listings: rentalListings
                .filter((listing) => listing.source === "ereality" && listing.disposition && listing.area)
                .map((listing) => ({
                    disposition: listing.disposition ?? "",
                    area: listing.area ?? 0,
                    rent: listing.price,
                    address: listing.locality,
                })),
        },
    ]);

    const result: FullAnalysis = {
        comparables,
        activeVsSold,
        trends,
        yield: yieldResult,
        timeOnMarket,
        discount,
        rentalListings,
        saleListings,
        bezrealitkyListings: {
            rentals:
                bezrealitkyRentalResult.status === "fulfilled"
                    ? bezrealitkyRentalResult.value.filter((listing) => listing.price >= MIN_RENTAL_PRICE)
                    : [],
            sales: bezrealitkySaleResult.status === "fulfilled" ? bezrealitkySaleResult.value : [],
        },
        mfBenchmarks,
        target,
        filters,
        investmentScore,
        momentum,
        rentalAggregation,
        providerSummary,
    };

    if (options?.persistResult !== false) {
        try {
            const fetchedAt = new Date().toISOString();
            const snapshotTargets = buildSuccessfulListingsSnapshotTargets({
                filters,
                providerSuccess: {
                    "reas:sold": reasResult.status === "fulfilled",
                    "sreality:rental": srealityRentalResult.status === "fulfilled",
                    "sreality:sale": srealitySaleResult.status === "fulfilled",
                    "bezrealitky:rental": bezrealitkyRentalResult.status === "fulfilled",
                    "bezrealitky:sale": bezrealitkySaleResult.status === "fulfilled",
                    "ereality:rental": erealityResult.status === "fulfilled",
                },
            });
            reasDatabase.saveAnalysis(result);
            reasDatabase.saveDistrictSnapshot(result);
            replaceListingsSnapshots({ district: filters.district.name, snapshotTargets });
            reasDatabase.upsertListings(
                buildPersistedListings({
                    districtName: filters.district.name,
                    fetchedAt,
                    soldListings: allListings,
                    saleListings,
                    rentalListings,
                }),
                filters.district.name
            );
            repairListingSnapshots({ district: filters.district.name, snapshotTargets });
        } catch {
            // Non-fatal — persistence failure should not break analysis
        }
    }

    onProgress?.({
        phase: "complete",
        message: `Data fetched: ${allListings.length} sold, ${saleListings.length} active sales, ${rentalListings.length} rentals, ${mfBenchmarks.length} MF benchmarks.`,
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

export interface FetchListingsIntoCacheOptions extends ListingsFetchInput {
    refresh?: boolean;
}

export interface FetchListingsIntoCacheResult {
    type: FetchableListingType;
    district: string;
    fetchedCount: number;
    persistedCount: number;
    providerCount: number;
    fetchedAt: string;
    warnings: string[];
}

export async function fetchListingsIntoCache(
    options: FetchListingsIntoCacheOptions
): Promise<FetchListingsIntoCacheResult> {
    const filters = buildListingsFetchFilters(options);
    const refresh = options.refresh ?? true;
    const warnings: string[] = [];
    const soldListings: ReasListing[] = [];
    const saleListings: SaleListing[] = [];
    const rentalListings: RentalListing[] = [];

    let soldFetchSucceeded = false;
    let srealityFetchSucceeded = false;
    let bezrealitkyFetchSucceeded = false;
    let erealityFetchSucceeded = false;

    const districtName = filters.district.name;

    function logFetchProvider(input: {
        provider: ProviderName;
        sourceContract: string;
        count: number;
        error?: string;
    }) {
        buildProviderSummary({ ...input, district: districtName });
    }

    if (options.type === "sold") {
        const soldResults = await Promise.allSettled(
            filters.periods.map((period) => fetchSoldListings(filters, period, refresh))
        );
        soldFetchSucceeded = soldResults.every((result) => result.status === "fulfilled");

        for (const result of soldResults) {
            if (result.status === "fulfilled") {
                soldListings.push(...result.value);
            } else {
                warnings.push(result.reason instanceof Error ? result.reason.message : "Failed to fetch sold listings");
            }
        }

        logFetchProvider({
            provider: "reas",
            sourceContract: "reas-catalog",
            count: soldListings.length,
            error: soldFetchSucceeded ? undefined : warnings[warnings.length - 1],
        });
    }

    if (options.type === "sale") {
        const [srealityResult, bezrealitkyResult] = await Promise.allSettled([
            isProviderEnabled(filters, "sreality")
                ? fetchSaleListings(filters, refresh)
                : Promise.resolve([] as SaleListing[]),
            isProviderEnabled(filters, "bezrealitky")
                ? fetchBezrealitkySales(filters, refresh)
                : Promise.resolve([] as SaleListing[]),
        ]);

        if (srealityResult.status === "fulfilled") {
            saleListings.push(...srealityResult.value);
            srealityFetchSucceeded = true;
        } else {
            warnings.push(
                srealityResult.reason instanceof Error
                    ? srealityResult.reason.message
                    : "Failed to fetch Sreality sales"
            );
        }

        logFetchProvider({
            provider: "sreality",
            sourceContract: "sreality-v2-sale",
            count: srealityResult.status === "fulfilled" ? srealityResult.value.length : 0,
            error:
                srealityResult.status === "rejected"
                    ? srealityResult.reason instanceof Error
                        ? srealityResult.reason.message
                        : String(srealityResult.reason)
                    : undefined,
        });

        if (bezrealitkyResult.status === "fulfilled") {
            saleListings.push(...bezrealitkyResult.value);
            bezrealitkyFetchSucceeded = true;
        } else {
            warnings.push(
                bezrealitkyResult.reason instanceof Error
                    ? bezrealitkyResult.reason.message
                    : "Failed to fetch Bezrealitky sales"
            );
        }

        logFetchProvider({
            provider: "bezrealitky",
            sourceContract: "graphql:listAdverts:sale",
            count: bezrealitkyResult.status === "fulfilled" ? bezrealitkyResult.value.length : 0,
            error:
                bezrealitkyResult.status === "rejected"
                    ? bezrealitkyResult.reason instanceof Error
                        ? bezrealitkyResult.reason.message
                        : String(bezrealitkyResult.reason)
                    : undefined,
        });
    }

    if (options.type === "rental") {
        const [srealityResult, bezrealitkyResult, erealityResult] = await Promise.allSettled([
            isProviderEnabled(filters, "sreality")
                ? fetchRentalListings(filters, refresh)
                : Promise.resolve([] as RentalListing[]),
            isProviderEnabled(filters, "bezrealitky")
                ? fetchBezrealitkyRentals(filters, refresh)
                : Promise.resolve([] as RentalListing[]),
            isProviderEnabled(filters, "ereality")
                ? fetchErealityRentals(filters, refresh)
                : Promise.resolve([] as RentalListing[]),
        ]);

        if (srealityResult.status === "fulfilled") {
            rentalListings.push(...srealityResult.value);
            srealityFetchSucceeded = true;
        } else {
            warnings.push(
                srealityResult.reason instanceof Error
                    ? srealityResult.reason.message
                    : "Failed to fetch Sreality rentals"
            );
        }

        logFetchProvider({
            provider: "sreality",
            sourceContract: "sreality-v2",
            count: srealityResult.status === "fulfilled" ? srealityResult.value.length : 0,
            error:
                srealityResult.status === "rejected"
                    ? srealityResult.reason instanceof Error
                        ? srealityResult.reason.message
                        : String(srealityResult.reason)
                    : undefined,
        });

        if (bezrealitkyResult.status === "fulfilled") {
            rentalListings.push(...bezrealitkyResult.value);
            bezrealitkyFetchSucceeded = true;
        } else {
            warnings.push(
                bezrealitkyResult.reason instanceof Error
                    ? bezrealitkyResult.reason.message
                    : "Failed to fetch Bezrealitky rentals"
            );
        }

        logFetchProvider({
            provider: "bezrealitky",
            sourceContract: "graphql:listAdverts",
            count: bezrealitkyResult.status === "fulfilled" ? bezrealitkyResult.value.length : 0,
            error:
                bezrealitkyResult.status === "rejected"
                    ? bezrealitkyResult.reason instanceof Error
                        ? bezrealitkyResult.reason.message
                        : String(bezrealitkyResult.reason)
                    : undefined,
        });

        if (erealityResult.status === "fulfilled") {
            rentalListings.push(...erealityResult.value);
            erealityFetchSucceeded = true;
        } else {
            warnings.push(
                erealityResult.reason instanceof Error
                    ? erealityResult.reason.message
                    : "Failed to fetch eReality rentals"
            );
        }

        logFetchProvider({
            provider: "ereality",
            sourceContract: "ereality-html",
            count: erealityResult.status === "fulfilled" ? erealityResult.value.length : 0,
            error:
                erealityResult.status === "rejected"
                    ? erealityResult.reason instanceof Error
                        ? erealityResult.reason.message
                        : String(erealityResult.reason)
                    : undefined,
        });
    }

    const fetchedAt = new Date().toISOString();
    const snapshotTargets = buildSuccessfulListingsSnapshotTargets({
        filters,
        listingType: options.type,
        providerSuccess: {
            "reas:sold": soldFetchSucceeded,
            "sreality:sale": srealityFetchSucceeded,
            "sreality:rental": srealityFetchSucceeded,
            "bezrealitky:sale": bezrealitkyFetchSucceeded,
            "bezrealitky:rental": bezrealitkyFetchSucceeded,
            "ereality:rental": erealityFetchSucceeded,
        },
    });
    const persistedListings = buildPersistedListings({
        districtName: filters.district.name,
        fetchedAt,
        soldListings,
        saleListings,
        rentalListings,
    });

    replaceListingsSnapshots({ district: filters.district.name, snapshotTargets });
    reasDatabase.upsertListings(persistedListings, filters.district.name);
    repairListingSnapshots({ district: filters.district.name, snapshotTargets });

    return {
        type: options.type,
        district: filters.district.name,
        fetchedCount: soldListings.length + saleListings.length + rentalListings.length,
        persistedCount: persistedListings.length,
        providerCount: new Set(persistedListings.map((listing) => listing.source)).size,
        fetchedAt,
        warnings,
    };
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
    const queryNormalized = stripDiacritics(options.query);

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

    const matched = allListings.filter((l) => stripDiacritics(l.formattedAddress).includes(queryNormalized));
    matched.sort((a, b) => new Date(b.soldAt).getTime() - new Date(a.soldAt).getTime());

    return matched;
}
