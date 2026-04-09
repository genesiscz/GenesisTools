import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import {
    ArrowDown,
    ArrowRight,
    ArrowUp,
    BarChart3,
    Calendar,
    Percent,
    ShieldCheck,
    Store,
    TrendingUp,
} from "lucide-react";
import { fmt, pct } from "../../lib/format";
import { GRADE_COLORS, getScoreCardModel } from "../analysis/display-model";
import { ComparisonMetric } from "./ComparisonMetric";
import type { DistrictComparison } from "./types";

interface ComparisonGridProps {
    comparisons: DistrictComparison[];
}

function formatCzk(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return "--";
    }

    return `${fmt(Math.round(value))} CZK`;
}

function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return "--";
    }

    return pct(value, { digits: 1 });
}

function formatDays(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return "--";
    }

    return `${Math.round(value)}d`;
}

function findBestWorst(
    values: Array<number | null | undefined>,
    higherIsBetter: boolean
): { bestIndex: number | null; worstIndex: number | null } {
    const valid = values
        .map((value, index) => (value !== null && value !== undefined ? { value, index } : null))
        .filter((entry): entry is { value: number; index: number } => entry !== null);

    if (valid.length < 2) {
        return { bestIndex: null, worstIndex: null };
    }

    const sorted = [...valid].sort((a, b) => (higherIsBetter ? b.value - a.value : a.value - b.value));
    return { bestIndex: sorted[0].index, worstIndex: sorted[sorted.length - 1].index };
}

function getTrendDirection(comparison: DistrictComparison): string {
    const latestSnapshot = comparison.snapshots[comparison.snapshots.length - 1] ?? null;

    if (latestSnapshot?.trendDirection) {
        return latestSnapshot.trendDirection;
    }

    const trends = comparison.exportData.analysis.trends;

    if (trends.length < 2) {
        return "stable";
    }

    const latest = trends[trends.length - 1];

    if (latest.qoqChange === null || latest.qoqChange === undefined) {
        return "stable";
    }

    if (latest.qoqChange > 2) {
        return "rising";
    }

    if (latest.qoqChange < -2) {
        return "declining";
    }

    return "stable";
}

function TrendIcon({ direction }: { direction: string }) {
    if (direction === "rising") {
        return <ArrowUp className="w-3.5 h-3.5 text-emerald-400" />;
    }

    if (direction === "declining") {
        return <ArrowDown className="w-3.5 h-3.5 text-red-400" />;
    }

    return <ArrowRight className="w-3.5 h-3.5 text-gray-400" />;
}

export function ComparisonGrid({ comparisons }: ComparisonGridProps) {
    if (comparisons.length === 0) {
        return null;
    }

    const scores = comparisons.map((comparison) => getScoreCardModel(comparison.exportData).grade);
    const medians = comparisons.map((comparison) => comparison.summary.medianPricePerM2);
    const netYields = comparisons.map((comparison) => comparison.summary.netYield);
    const grossYields = comparisons.map((comparison) => comparison.summary.grossYield);
    const daysOnMarket = comparisons.map((comparison) => comparison.summary.daysOnMarket);
    const percentiles = comparisons.map((comparison) => comparison.summary.targetPercentile);
    const salesCounts = comparisons.map((comparison) => comparison.summary.salesCount);
    const rentalCounts = comparisons.map((comparison) => comparison.summary.rentalCount);
    const discounts = comparisons.map((comparison) => comparison.exportData.analysis.discount.medianDiscount);
    const directions = comparisons.map((comparison) => getTrendDirection(comparison));

    const medianBW = findBestWorst(medians, false);
    const netYieldBW = findBestWorst(netYields, true);
    const grossYieldBW = findBestWorst(grossYields, true);
    const daysBW = findBestWorst(daysOnMarket, false);
    const percentileBW = findBestWorst(percentiles, false);
    const salesBW = findBestWorst(salesCounts, true);
    const rentalBW = findBestWorst(rentalCounts, true);
    const discountBW = findBestWorst(discounts, true);

    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                    <BarChart3 className="w-4 h-4" />
                    Side-by-side comparison
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-0 overflow-x-auto">
                <div className="min-w-[720px]">
                    <div
                        className="grid gap-2 mb-2"
                        style={{ gridTemplateColumns: `140px repeat(${comparisons.length}, 1fr)` }}
                    >
                        <div />
                        {comparisons.map((comparison, index) => (
                            <div key={comparison.district} className="text-center py-2">
                                <span className="text-sm font-mono font-bold text-gray-200">{comparison.district}</span>
                                <Badge
                                    variant="outline"
                                    className={`ml-2 text-xs ${GRADE_COLORS[scores[index] ?? "C"] ?? "text-gray-400"}`}
                                >
                                    {scores[index]}
                                </Badge>
                            </div>
                        ))}
                    </div>

                    <ComparisonMetric
                        label="Median CZK/m2"
                        icon={<BarChart3 className="w-3 h-3" />}
                        values={comparisons.map((comparison, index) => ({
                            district: comparison.district,
                            value: medians[index],
                            formatted: formatCzk(medians[index]),
                        }))}
                        bestIndex={medianBW.bestIndex}
                        worstIndex={medianBW.worstIndex}
                    />

                    <ComparisonMetric
                        label="Net Yield"
                        icon={<Percent className="w-3 h-3" />}
                        values={comparisons.map((comparison, index) => ({
                            district: comparison.district,
                            value: netYields[index],
                            formatted: formatPercent(netYields[index]),
                        }))}
                        bestIndex={netYieldBW.bestIndex}
                        worstIndex={netYieldBW.worstIndex}
                    />

                    <ComparisonMetric
                        label="Gross Yield"
                        icon={<Percent className="w-3 h-3" />}
                        values={comparisons.map((comparison, index) => ({
                            district: comparison.district,
                            value: grossYields[index],
                            formatted: formatPercent(grossYields[index]),
                        }))}
                        bestIndex={grossYieldBW.bestIndex}
                        worstIndex={grossYieldBW.worstIndex}
                    />

                    <ComparisonMetric
                        label="Days on Market"
                        icon={<Calendar className="w-3 h-3" />}
                        values={comparisons.map((comparison, index) => ({
                            district: comparison.district,
                            value: daysOnMarket[index],
                            formatted: formatDays(daysOnMarket[index]),
                        }))}
                        bestIndex={daysBW.bestIndex}
                        worstIndex={daysBW.worstIndex}
                    />

                    <ComparisonMetric
                        label="Target Percentile"
                        icon={<ShieldCheck className="w-3 h-3" />}
                        values={comparisons.map((comparison, index) => ({
                            district: comparison.district,
                            value: percentiles[index],
                            formatted: `${percentiles[index].toFixed(0)}th`,
                        }))}
                        bestIndex={percentileBW.bestIndex}
                        worstIndex={percentileBW.worstIndex}
                    />

                    <ComparisonMetric
                        label="Median Discount"
                        icon={<ShieldCheck className="w-3 h-3" />}
                        values={comparisons.map((comparison, index) => ({
                            district: comparison.district,
                            value: discounts[index],
                            formatted: formatPercent(discounts[index]),
                        }))}
                        bestIndex={discountBW.bestIndex}
                        worstIndex={discountBW.worstIndex}
                    />

                    <ComparisonMetric
                        label="Sold Listings"
                        icon={<Store className="w-3 h-3" />}
                        values={comparisons.map((comparison, index) => ({
                            district: comparison.district,
                            value: salesCounts[index],
                            formatted: String(salesCounts[index]),
                        }))}
                        bestIndex={salesBW.bestIndex}
                        worstIndex={salesBW.worstIndex}
                    />

                    <ComparisonMetric
                        label="Rental Listings"
                        icon={<Store className="w-3 h-3" />}
                        values={comparisons.map((comparison, index) => ({
                            district: comparison.district,
                            value: rentalCounts[index],
                            formatted: String(rentalCounts[index]),
                        }))}
                        bestIndex={rentalBW.bestIndex}
                        worstIndex={rentalBW.worstIndex}
                    />

                    <ComparisonMetric
                        label="Trend"
                        icon={<TrendingUp className="w-3 h-3" />}
                        values={comparisons.map((comparison, index) => ({
                            district: comparison.district,
                            value: directions[index],
                            formatted: directions[index],
                        }))}
                        bestIndex={null}
                        worstIndex={null}
                    />

                    <div
                        className="grid gap-2"
                        style={{ gridTemplateColumns: `140px repeat(${comparisons.length}, 1fr)` }}
                    >
                        <div />
                        {directions.map((direction, index) => (
                            <div key={comparisons[index].district} className="flex items-center justify-center py-1">
                                <TrendIcon direction={direction} />
                                <span className="text-[10px] font-mono text-gray-500 ml-1">{direction}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
