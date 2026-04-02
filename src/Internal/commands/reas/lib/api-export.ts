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
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function hasObjectProperty(value: Record<string, unknown>, key: string): value is Record<string, Record<string, unknown>> {
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

function buildComparablesScatter(analysis: FullAnalysis) {
    return (analysis.comparables.listings ?? []).map((listing) => ({
        area: listing.utilityArea ?? listing.displayArea,
        pricePerM2: listing.pricePerM2 ?? 0,
        disposition: listing.disposition,
        address: listing.formattedAddress,
        source: "reas",
        link: listing.link,
    }));
}

export interface DashboardExport {
    meta: {
        generatedAt: string;
        version: "1.0";
        filters: AnalysisFilters;
        target: TargetProperty;
        providers: string[];
        providerSummary?: ProviderFetchSummary[];
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
        }>;
        activeSales: Array<{
            disposition?: string;
            area?: number;
            price: number;
            pricePerM2?: number;
            address: string;
            link: string;
            source: string;
        }>;
        rentals: Array<{
            disposition: string;
            area: number;
            rent: number;
            rentPerM2: number;
            address: string;
            link: string;
            source: string;
        }>;
    };
    analysis: {
        comparables: {
            median: number;
            mean: number;
            p25: number;
            p75: number;
            count: number;
            targetPercentile: number;
        };
        trends: Array<{
            period: string;
            medianPricePerM2: number;
            count: number;
            qoqChange?: number | null;
        }>;
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
        };
        timeOnMarket: {
            median: number;
            mean: number;
            min: number;
            max: number;
        };
        discount: {
            avgDiscount: number;
            medianDiscount: number;
            maxDiscount: number;
        };
        investmentScore?: {
            overall: number;
            grade: string;
            reasoning: string[];
            recommendation: string;
        };
        momentum?: {
            direction: string;
            priceVelocity: number;
            momentum: string;
            confidence: string;
            interpretation: string;
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
        }>;
        rentalAggregation?: AggregatedRentalStats[];
    };
    benchmarks: {
        mf: MfRentalBenchmark[];
        investmentBenchmarks: Array<{ name: string; annualReturn: number }>;
    };
}

export type { FullAnalysis } from "@app/Internal/commands/reas/types";

export function isDashboardExport(value: unknown): value is DashboardExport {
    if (!isRecord(value)) {
        return false;
    }

    if (!hasObjectProperty(value, "meta") || !hasObjectProperty(value, "listings") || !hasObjectProperty(value, "analysis")) {
        return false;
    }

    return hasObjectProperty(value, "benchmarks");
}

export function buildDashboardExport(analysis: FullAnalysis): DashboardExport {
    const { comparables, trends, timeOnMarket, discount, yield: yieldResult } = analysis;
    const priceHistogram = buildHistogram(
        (comparables.listings ?? []).map((listing) => listing.pricePerM2 ?? 0).filter((value) => value > 0)
    );
    const domDistribution = buildHistogram(
        (comparables.listings ?? []).map((listing) => listing.daysOnMarket ?? 0).filter((value) => value > 0)
    );
    const scatter = buildComparablesScatter(analysis);

    return {
        meta: {
            generatedAt: new Date().toISOString(),
            version: "1.0",
            filters: analysis.filters,
            target: analysis.target,
            providers: analysis.filters.providers ?? ["reas", "sreality", "mf"],
            providerSummary: analysis.providerSummary,
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
            })),
            activeSales: (analysis.saleListings ?? []).map((listing) => ({
                disposition: listing.disposition,
                area: listing.area,
                price: listing.price,
                pricePerM2: listing.pricePerM2,
                address: listing.address,
                link: listing.link,
                source: listing.source,
            })),
            rentals: analysis.rentalListings.map((r) => ({
                disposition: r.disposition ?? "",
                area: r.area ?? 0,
                rent: r.price,
                rentPerM2: r.area ? r.price / r.area : 0,
                address: r.locality,
                link: r.link ?? "",
                source: r.source,
            })),
        },
        analysis: {
            comparables: {
                median: comparables.pricePerM2.median,
                mean: comparables.pricePerM2.mean,
                p25: comparables.pricePerM2.p25,
                p75: comparables.pricePerM2.p75,
                count: comparables.listings?.length ?? 0,
                targetPercentile: comparables.targetPercentile,
            },
            trends: (trends.periods ?? []).map((p) => ({
                period: p.label,
                medianPricePerM2: p.medianPerM2,
                count: p.count,
                qoqChange: p.change,
            })),
            yield: {
                grossYield: yieldResult.grossYield,
                netYield: yieldResult.netYield,
                paybackYears: yieldResult.paybackYears,
                atMarketPrice: yieldResult.atMarketPrice,
            },
            timeOnMarket: {
                median: timeOnMarket.median,
                mean: timeOnMarket.mean,
                min: timeOnMarket.min,
                max: timeOnMarket.max,
            },
            discount: {
                avgDiscount: discount.avgDiscount,
                medianDiscount: discount.medianDiscount,
                maxDiscount: discount.maxDiscount,
            },
            investmentScore: analysis.investmentScore
                ? {
                      overall: analysis.investmentScore.overall,
                      grade: analysis.investmentScore.grade,
                      reasoning: analysis.investmentScore.reasoning,
                      recommendation: analysis.investmentScore.recommendation,
                  }
                : undefined,
            momentum: analysis.momentum
                ? {
                      direction: analysis.momentum.direction,
                      priceVelocity: analysis.momentum.priceVelocity,
                      momentum: analysis.momentum.momentum,
                      confidence: analysis.momentum.confidence,
                      interpretation: analysis.momentum.interpretation,
                  }
                : undefined,
            priceHistogram,
            domDistribution,
            scatter,
            rentalAggregation: analysis.rentalAggregation,
        },
        benchmarks: {
            mf: analysis.mfBenchmarks,
            investmentBenchmarks: [
                { name: "Czech govt bonds", annualReturn: 4.2 },
                { name: "S&P 500 avg", annualReturn: 10 },
                { name: "Prague avg yield", annualReturn: 3.5 },
            ],
        },
    };
}
