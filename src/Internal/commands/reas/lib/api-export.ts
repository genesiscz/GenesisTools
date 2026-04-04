import { analyzeActiveVsSold } from "@app/Internal/commands/reas/analysis/active-vs-sold";
import {
    computeDispositionYields,
    type DispositionYieldRow,
    estimateRent,
    type RentEstimation,
} from "@app/Internal/commands/reas/analysis/rent-estimation";
import type { AggregatedRentalStats } from "@app/Internal/commands/reas/analysis/rental-aggregation";
import type {
    AnalysisFilters,
    FullAnalysis,
    MfRentalBenchmark,
    ProviderFetchSummary,
    TargetProperty,
} from "@app/Internal/commands/reas/types";

interface HistogramBucket {
    range: string;
    count: number;
    provenance?: DashboardProvenance;
}

export interface DashboardProviderDetail {
    provider: string;
    sourceContract: string;
    count: number;
    fetchedAt: string;
    status: "ok" | "warning" | "error";
    message?: string;
}

export interface DashboardProvenance {
    label: string;
    providers: string[];
    sourceContracts: string[];
    providerDetails: DashboardProviderDetail[];
    count?: number;
    note?: string;
}

export interface DashboardSectionProvenance extends DashboardProvenance {
    metrics?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function hasObjectProperty(
    value: Record<string, unknown>,
    key: string
): value is Record<string, Record<string, unknown>> {
    return isRecord(value[key]);
}

function buildHistogram(values: number[], bucketCount = 6): HistogramBucket[] {
    if (values.length === 0) {
        return [];
    }

    const min = Math.min(...values);
    const max = Math.max(...values);

    if (min === max) {
        return [{ range: `${Math.round(min)}`, count: values.length }];
    }

    const size = (max - min) / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_, index) => ({
        from: min + size * index,
        to: index === bucketCount - 1 ? max : min + size * (index + 1),
        count: 0,
    }));

    for (const value of values) {
        const index = Math.min(Math.floor((value - min) / size), bucketCount - 1);
        buckets[index].count += 1;
    }

    return buckets.map((bucket) => ({
        range: `${Math.round(bucket.from)}-${Math.round(bucket.to)}`,
        count: bucket.count,
    }));
}

const DEFAULT_DASHBOARD_PROVIDERS: string[] = ["reas", "sreality", "bezrealitky", "ereality", "mf"];

function getDefaultDashboardProviders(analysis: FullAnalysis): string[] {
    if (analysis.filters.providers && analysis.filters.providers.length > 0) {
        return [...analysis.filters.providers];
    }

    return DEFAULT_DASHBOARD_PROVIDERS;
}

function getProviderMessage(item: ProviderFetchSummary): {
    status: DashboardProviderDetail["status"];
    message?: string;
} {
    if (item.error) {
        return {
            status: "error",
            message: item.error,
        };
    }

    if (item.count === 0) {
        return {
            status: "warning",
            message: "Returned 0 rows for the current filters.",
        };
    }

    return {
        status: "ok",
    };
}

function buildProvenance({
    label,
    providerSummary,
    providers,
    count,
    note,
}: {
    label: string;
    providerSummary?: ProviderFetchSummary[];
    providers: string[];
    count?: number;
    note?: string;
}): DashboardProvenance {
    const relevant = (providerSummary ?? []).filter((item) => providers.includes(item.provider));
    const sourceContracts = Array.from(new Set(relevant.map((item) => item.sourceContract)));
    const providerDetails = relevant.map((item) => ({
        provider: item.provider,
        sourceContract: item.sourceContract,
        count: item.count,
        fetchedAt: item.fetchedAt,
        ...getProviderMessage(item),
    }));

    return {
        label,
        providers,
        sourceContracts,
        providerDetails,
        count,
        note,
    };
}

function buildListingProvenance({
    label,
    providerSummary,
    provider,
    sourceContract,
    count,
    note,
}: {
    label: string;
    providerSummary?: ProviderFetchSummary[];
    provider: string;
    sourceContract?: string;
    count?: number;
    note?: string;
}): DashboardProvenance {
    const base = buildProvenance({
        label,
        providerSummary,
        providers: [provider],
        count,
        note,
    });

    if (!sourceContract) {
        return base;
    }

    return {
        ...base,
        sourceContracts: base.sourceContracts.filter((item) => item === sourceContract),
        providerDetails: base.providerDetails.filter((item) => item.sourceContract === sourceContract),
    };
}

export interface DashboardExport {
    meta: {
        generatedAt: string;
        version: "1.0";
        filters: AnalysisFilters;
        target: TargetProperty;
        providers: string[];
        providerSummary?: ProviderFetchSummary[];
        provenance?: {
            sections: {
                overview: DashboardSectionProvenance;
                priceDistribution: DashboardSectionProvenance;
                trend: DashboardSectionProvenance;
                comparables: DashboardSectionProvenance;
                rentals: DashboardSectionProvenance;
                investment: DashboardSectionProvenance;
                verdict: DashboardSectionProvenance;
            };
        };
    };
    listings: {
        sold: Array<{
            disposition: string;
            area: number;
            price: number;
            pricePerM2: number;
            address: string;
            soldAt?: string;
            daysOnMarket?: number;
            discount?: number;
            link: string;
            source: string;
            sourceContract?: string;
            provenance?: DashboardProvenance;
        }>;
        activeSales: Array<{
            disposition?: string;
            area?: number;
            price: number;
            pricePerM2?: number;
            address: string;
            link: string;
            source: string;
            sourceContract?: string;
            provenance?: DashboardProvenance;
        }>;
        rentals: Array<{
            disposition: string;
            area: number;
            rent: number;
            rentPerM2: number;
            address: string;
            link: string;
            source: string;
            sourceContract?: string;
            provenance?: DashboardProvenance;
        }>;
        bezrealitky?: {
            sales: Array<{
                disposition?: string;
                area?: number;
                price: number;
                pricePerM2?: number;
                address: string;
                link: string;
                source: string;
                sourceContract?: string;
                provenance?: DashboardProvenance;
            }>;
            rentals: Array<{
                disposition: string;
                area: number;
                rent: number;
                rentPerM2: number;
                address: string;
                link: string;
                source: string;
                sourceContract?: string;
                provenance?: DashboardProvenance;
            }>;
        };
    };
    analysis: {
        comparables: {
            median: number;
            mean: number;
            p25: number;
            p75: number;
            count: number;
            targetPercentile: number;
            provenance?: DashboardProvenance;
        };
        activeVsSold?: {
            activeCount: number;
            soldCount: number;
            medianActivePricePerM2: number;
            medianSoldPricePerM2: number;
            askingToSoldRatio: number;
            askingPremiumPct: number;
            provenance?: DashboardProvenance;
        };
        trends: Array<{
            period: string;
            medianPricePerM2: number;
            count: number;
            qoqChange?: number | null;
            provenance?: DashboardProvenance;
        }>;
        trendProvenance?: DashboardProvenance;
        yield: {
            grossYield: number;
            netYield: number;
            paybackYears: number;
            atMarketPrice: {
                price: number;
                grossYield: number;
                netYield: number;
                paybackYears: number;
            };
            provenance?: DashboardProvenance;
        };
        timeOnMarket: {
            median: number;
            mean: number;
            min: number;
            max: number;
            provenance?: DashboardProvenance;
        };
        discount: {
            avgDiscount: number;
            medianDiscount: number;
            maxDiscount: number;
            provenance?: DashboardProvenance;
        };
        investmentScore?: {
            overall: number;
            grade: string;
            factors?: {
                yieldScore: number;
                discountScore: number;
                trendScore: number;
                marketVelocityScore: number;
            };
            reasoning: string[];
            recommendation: string;
            provenance?: DashboardProvenance;
        };
        momentum?: {
            direction: string;
            priceVelocity: number;
            momentum: string;
            confidence: string;
            interpretation: string;
            provenance?: DashboardProvenance;
        };
        priceHistogram: HistogramBucket[];
        domDistribution: HistogramBucket[];
        scatter: Array<{
            area: number;
            pricePerM2: number;
            disposition: string;
            address: string;
            source: string;
            link: string;
            sourceContract?: string;
            provenance?: DashboardProvenance;
        }>;
        rentalAggregation?: Array<AggregatedRentalStats & { provenance?: DashboardProvenance }>;
        rentalAggregationProvenance?: DashboardProvenance;
        dispositionYields?: DispositionYieldRow[];
        rentEstimation?: RentEstimation;
    };
    benchmarks: {
        mf: MfRentalBenchmark[];
        provenance?: DashboardProvenance;
        investmentBenchmarks: Array<{ name: string; annualReturn: number }>;
    };
}

export type { FullAnalysis } from "@app/Internal/commands/reas/types";

export function isDashboardExport(value: unknown): value is DashboardExport {
    if (!isRecord(value)) {
        return false;
    }

    if (
        !hasObjectProperty(value, "meta") ||
        !hasObjectProperty(value, "listings") ||
        !hasObjectProperty(value, "analysis")
    ) {
        return false;
    }

    return hasObjectProperty(value, "benchmarks");
}

export function buildDashboardExport(analysis: FullAnalysis): DashboardExport {
    const { comparables, trends, timeOnMarket, discount, yield: yieldResult } = analysis;
    const activeVsSold =
        analysis.activeVsSold ??
        analyzeActiveVsSold({
            activeListings: analysis.saleListings ?? [],
            soldListings: comparables.listings ?? [],
        });
    const providerSummary = analysis.providerSummary;
    const priceHistogram = buildHistogram(
        (comparables.listings ?? []).map((listing) => listing.pricePerM2 ?? 0).filter((value) => value > 0)
    );
    const domDistribution = buildHistogram(
        (comparables.listings ?? []).map((listing) => listing.daysOnMarket ?? 0).filter((value) => value > 0)
    );
    const soldCount = comparables.listings?.length ?? 0;
    const activeSaleCount = analysis.saleListings?.length ?? 0;
    const rentalCount = analysis.rentalListings.length;
    const mfCount = analysis.mfBenchmarks.length;
    const soldListings = comparables.listings ?? [];
    const rentalSectionProviders =
        mfCount > 0 ? ["sreality", "bezrealitky", "ereality", "mf"] : ["sreality", "bezrealitky", "ereality"];
    const comparablesProvenance = buildProvenance({
        label: "Sold comparables",
        providerSummary,
        providers: ["reas"],
        count: soldCount,
        note: "Sold-market pricing comes from REAS cadastral transactions.",
    });
    const trendProvenance = buildProvenance({
        label: "Trend analysis",
        providerSummary,
        providers: ["reas"],
        count: soldCount,
        note: "Trend periods are derived from REAS sold comparables in the selected periods.",
    });
    const rentalProvenance = buildProvenance({
        label: "Rental supply",
        providerSummary,
        providers: rentalSectionProviders,
        count: rentalCount + mfCount,
        note:
            mfCount > 0
                ? "Rental evidence is aggregated across active provider inventory with deduplication and MF benchmark context."
                : "Rental evidence is aggregated across active provider inventory with deduplication.",
    });
    const investmentProvenance = buildProvenance({
        label: "Investment scoring",
        providerSummary,
        providers: ["reas", "sreality", "bezrealitky", "ereality", "mf"],
        count: soldCount + rentalCount + mfCount,
        note: "Investment outputs combine sold pricing, rental evidence, and MF benchmark context.",
    });
    const scatter = soldListings.map((listing) => ({
        area: listing.utilityArea ?? listing.displayArea,
        pricePerM2: listing.pricePerM2 ?? 0,
        disposition: listing.disposition,
        address: listing.formattedAddress,
        source: "reas",
        link: listing.link,
        sourceContract: "reas-catalog",
        provenance: buildListingProvenance({
            label: `Comparable sale · ${listing.formattedAddress}`,
            providerSummary,
            provider: "reas",
            sourceContract: "reas-catalog",
            count: 1,
            note: listing.soldAt
                ? `Sold comparable recorded at ${listing.formattedAddress} on ${listing.soldAt}.`
                : `Sold comparable recorded at ${listing.formattedAddress}.`,
        }),
    }));
    const trendPoints = (trends.periods ?? []).map((period) => ({
        period: period.label,
        medianPricePerM2: period.medianPerM2,
        count: period.count,
        qoqChange: period.change,
        provenance: {
            ...trendProvenance,
            label: `Trend period · ${period.label}`,
            count: period.count,
            note: `${period.count} sold comparables contributed to ${period.label}.`,
        },
    }));
    const priceHistogramWithProvenance = priceHistogram.map((bucket) => ({
        ...bucket,
        provenance: {
            ...comparablesProvenance,
            label: `Price bucket · ${bucket.range}`,
            count: bucket.count,
            note: `${bucket.count} sold comparables fall into the ${bucket.range} CZK / m² bucket.`,
        },
    }));
    const domDistributionWithProvenance = domDistribution.map((bucket) => ({
        ...bucket,
        provenance: {
            ...comparablesProvenance,
            label: `DOM bucket · ${bucket.range}`,
            count: bucket.count,
            note: `${bucket.count} sold comparables fall into the ${bucket.range} day bucket.`,
        },
    }));
    const rentalAggregationWithProvenance = (analysis.rentalAggregation ?? []).map((group) => ({
        ...group,
        provenance: buildProvenance({
            label: `Rental aggregation · ${group.disposition}`,
            providerSummary,
            providers: Object.keys(group.sources),
            count: group.count,
            note: `${group.count} deduplicated rental rows contributed to the ${group.disposition} rental aggregation.`,
        }),
    }));

    return {
        meta: {
            generatedAt: new Date().toISOString(),
            version: "1.0",
            filters: analysis.filters,
            target: analysis.target,
            providers: getDefaultDashboardProviders(analysis),
            providerSummary,
            provenance: {
                sections: {
                    overview: {
                        ...buildProvenance({
                            label: "Overview",
                            providerSummary,
                            providers: ["reas", "sreality", "bezrealitky", "ereality", "mf"],
                            count: soldCount + activeSaleCount + rentalCount + mfCount,
                            note: "Overview blends sold comps, active supply, rental evidence, and benchmarks.",
                        }),
                        metrics: ["Target price / m²", "Net yield", "Active sales gap", "Provider summary"],
                    },
                    priceDistribution: {
                        ...buildProvenance({
                            label: "Price distribution",
                            providerSummary,
                            providers: ["reas"],
                            count: soldCount,
                            note: "Histogram buckets are computed from sold REAS comparables.",
                        }),
                        metrics: ["Histogram", "DOM distribution", "Percentile band"],
                    },
                    trend: {
                        ...trendProvenance,
                        metrics: ["Median price trajectory", "QoQ velocity", "Momentum"],
                    },
                    comparables: {
                        ...buildProvenance({
                            label: "Comparables",
                            providerSummary,
                            providers: ["reas", "sreality", "bezrealitky"],
                            count: soldCount + activeSaleCount,
                            note: "Sold pricing uses REAS; asking-price context uses active sale inventory.",
                        }),
                        metrics: ["Sold table", "Scatter plot", "Active sales context"],
                    },
                    rentals: {
                        ...rentalProvenance,
                        metrics: ["Rental aggregation", "Rental rows", "MF benchmark overlay"],
                    },
                    investment: {
                        ...investmentProvenance,
                        metrics: ["Score breakdown", "Scenario sensitivity", "Benchmark spread"],
                    },
                    verdict: {
                        ...investmentProvenance,
                        metrics: ["Conviction", "Pros / cons", "Checklist"],
                    },
                },
            },
        },
        listings: {
            sold: (comparables.listings ?? []).map((l) => ({
                disposition: l.disposition,
                area: l.utilityArea ?? l.displayArea,
                price: l.soldPrice,
                pricePerM2: l.pricePerM2,
                address: l.formattedAddress,
                soldAt: l.soldAt,
                daysOnMarket: l.daysOnMarket,
                discount: l.discount,
                link: l.link ?? "",
                source: "reas",
                sourceContract: "reas-catalog",
                provenance: buildListingProvenance({
                    label: `Sold comparable · ${l.formattedAddress}`,
                    providerSummary,
                    provider: "reas",
                    sourceContract: "reas-catalog",
                    count: 1,
                    note: l.soldAt
                        ? `Sold comparable captured from REAS on ${l.soldAt}.`
                        : "Sold comparable captured from REAS.",
                }),
            })),
            activeSales: (analysis.saleListings ?? []).map((listing) => ({
                disposition: listing.disposition,
                area: listing.area,
                price: listing.price,
                pricePerM2: listing.pricePerM2,
                address: listing.address,
                link: listing.link,
                source: listing.source,
                sourceContract: listing.sourceContract,
                provenance: buildListingProvenance({
                    label: `Active sale · ${listing.address}`,
                    providerSummary,
                    provider: listing.source,
                    sourceContract: listing.sourceContract,
                    count: 1,
                    note: `Active asking listing from ${listing.source} at ${listing.address}.`,
                }),
            })),
            rentals: analysis.rentalListings.map((r) => ({
                disposition: r.disposition ?? "",
                area: r.area ?? 0,
                rent: r.price,
                rentPerM2: r.area ? r.price / r.area : 0,
                address: r.locality,
                link: r.link ?? "",
                source: r.source,
                sourceContract: r.sourceContract,
                provenance: buildListingProvenance({
                    label: `Rental row · ${r.locality}`,
                    providerSummary,
                    provider: r.source,
                    sourceContract: r.sourceContract,
                    count: 1,
                    note: `Rental row from ${r.source} at ${r.locality}.`,
                }),
            })),
            bezrealitky: {
                sales: (analysis.bezrealitkyListings?.sales ?? []).map((listing) => ({
                    disposition: listing.disposition,
                    area: listing.area,
                    price: listing.price,
                    pricePerM2: listing.pricePerM2,
                    address: listing.address,
                    link: listing.link,
                    source: listing.source,
                    sourceContract: listing.sourceContract,
                    provenance: buildListingProvenance({
                        label: `Bezrealitky sale · ${listing.address}`,
                        providerSummary,
                        provider: listing.source,
                        sourceContract: listing.sourceContract,
                        count: 1,
                        note: `Active sale row from ${listing.source} at ${listing.address}.`,
                    }),
                })),
                rentals: (analysis.bezrealitkyListings?.rentals ?? []).map((listing) => ({
                    disposition: listing.disposition ?? "",
                    area: listing.area ?? 0,
                    rent: listing.price,
                    rentPerM2: listing.area ? listing.price / listing.area : 0,
                    address: listing.locality,
                    link: listing.link ?? "",
                    source: listing.source,
                    sourceContract: listing.sourceContract,
                    provenance: buildListingProvenance({
                        label: `Bezrealitky rental · ${listing.locality}`,
                        providerSummary,
                        provider: listing.source,
                        sourceContract: listing.sourceContract,
                        count: 1,
                        note: `Rental row from ${listing.source} at ${listing.locality}.`,
                    }),
                })),
            },
        },
        analysis: {
            comparables: {
                median: comparables.pricePerM2.median,
                mean: comparables.pricePerM2.mean,
                p25: comparables.pricePerM2.p25,
                p75: comparables.pricePerM2.p75,
                count: comparables.listings?.length ?? 0,
                targetPercentile: comparables.targetPercentile,
                provenance: comparablesProvenance,
            },
            activeVsSold: activeVsSold
                ? {
                      activeCount: activeVsSold.activeCount,
                      soldCount: activeVsSold.soldCount,
                      medianActivePricePerM2: activeVsSold.medianActivePricePerM2,
                      medianSoldPricePerM2: activeVsSold.medianSoldPricePerM2,
                      askingToSoldRatio: activeVsSold.askingToSoldRatio,
                      askingPremiumPct: activeVsSold.askingPremiumPct,
                      provenance: buildProvenance({
                          label: "Active vs sold pricing",
                          providerSummary,
                          providers: ["reas", "sreality", "bezrealitky"],
                          count: activeVsSold.activeCount + activeVsSold.soldCount,
                          note: "Median asking inventory is compared against median sold pricing in the same export.",
                      }),
                  }
                : undefined,
            trends: trendPoints,
            trendProvenance,
            yield: {
                grossYield: yieldResult.grossYield,
                netYield: yieldResult.netYield,
                paybackYears: yieldResult.paybackYears,
                atMarketPrice: yieldResult.atMarketPrice,
                provenance: buildProvenance({
                    label: "Yield model",
                    providerSummary,
                    providers: ["reas", "sreality", "bezrealitky", "ereality"],
                    count: soldCount + rentalCount,
                    note: "Yield combines sold-price median with filtered rental evidence for the selected target.",
                }),
            },
            timeOnMarket: {
                median: timeOnMarket.median,
                mean: timeOnMarket.mean,
                min: timeOnMarket.min,
                max: timeOnMarket.max,
                provenance: comparablesProvenance,
            },
            discount: {
                avgDiscount: discount.avgDiscount,
                medianDiscount: discount.medianDiscount,
                maxDiscount: discount.maxDiscount,
                provenance: comparablesProvenance,
            },
            investmentScore: analysis.investmentScore
                ? {
                      overall: analysis.investmentScore.overall,
                      grade: analysis.investmentScore.grade,
                      factors: analysis.investmentScore.factors,
                      reasoning: analysis.investmentScore.reasoning,
                      recommendation: analysis.investmentScore.recommendation,
                      provenance: investmentProvenance,
                  }
                : undefined,
            momentum: analysis.momentum
                ? {
                      direction: analysis.momentum.direction,
                      priceVelocity: analysis.momentum.priceVelocity,
                      momentum: analysis.momentum.momentum,
                      confidence: analysis.momentum.confidence,
                      interpretation: analysis.momentum.interpretation,
                      provenance: trendProvenance,
                  }
                : undefined,
            priceHistogram: priceHistogramWithProvenance,
            domDistribution: domDistributionWithProvenance,
            scatter,
            rentalAggregation: rentalAggregationWithProvenance,
            rentalAggregationProvenance: rentalProvenance,
            dispositionYields: computeDispositionYields({
                rentals: analysis.rentalListings,
                soldListings: comparables.listings ?? [],
            }),
            rentEstimation: estimateRent({
                area: analysis.target.area,
                disposition: analysis.filters.disposition ?? undefined,
                rentals: analysis.rentalListings,
            }),
        },
        benchmarks: {
            mf: analysis.mfBenchmarks,
            provenance: buildProvenance({
                label: "MF benchmarks",
                providerSummary,
                providers: ["mf"],
                count: mfCount,
                note: "Government rental reference prices from MF cenová mapa.",
            }),
            investmentBenchmarks: [
                { name: "Czech govt bonds", annualReturn: 4.2 },
                { name: "S&P 500 avg", annualReturn: 10 },
                { name: "Prague avg yield", annualReturn: 3.5 },
            ],
        },
    };
}
