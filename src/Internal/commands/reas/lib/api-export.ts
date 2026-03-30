import type { ComparablesResult } from "../analysis/comparables";
import type { DiscountResult } from "../analysis/discount";
import type { AggregatedRentalStats } from "../analysis/rental-aggregation";
import type { YieldResult } from "../analysis/rental-yield";
import type { TimeOnMarketResult } from "../analysis/time-on-market";
import type { TrendsResult } from "../analysis/trends";
import type { AnalysisFilters, MfRentalBenchmark, SrealityRental, TargetProperty } from "../types";

export interface DashboardExport {
    meta: {
        generatedAt: string;
        version: "1.0";
        filters: AnalysisFilters;
        target: TargetProperty;
        providers: string[];
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
        rentalAggregation?: AggregatedRentalStats[];
    };
    benchmarks: {
        mf: MfRentalBenchmark[];
        investmentBenchmarks: Array<{ name: string; annualReturn: number }>;
    };
}

export interface FullAnalysis {
    comparables: ComparablesResult;
    trends: TrendsResult;
    timeOnMarket: TimeOnMarketResult;
    discount: DiscountResult;
    yield: YieldResult;
    rentals: SrealityRental[];
    mfBenchmarks: MfRentalBenchmark[];
    filters: AnalysisFilters;
    target: TargetProperty;
    rentalAggregation?: AggregatedRentalStats[];
}

export function buildDashboardExport(analysis: FullAnalysis): DashboardExport {
    const { comparables, trends, timeOnMarket, discount, yield: yieldResult } = analysis;

    return {
        meta: {
            generatedAt: new Date().toISOString(),
            version: "1.0",
            filters: analysis.filters,
            target: analysis.target,
            providers: analysis.filters.providers ?? ["reas", "sreality", "mf"],
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
            rentals: analysis.rentals.map((r) => ({
                disposition: r.disposition ?? "",
                area: r.area ?? 0,
                rent: r.price,
                rentPerM2: r.area ? r.price / r.area : 0,
                address: r.locality,
                link: r.link ?? "",
                source: "sreality",
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
