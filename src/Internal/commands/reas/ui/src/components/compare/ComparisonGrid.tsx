import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { ArrowDown, ArrowRight, ArrowUp, BarChart3, Calendar, Percent, ShieldCheck, TrendingUp } from "lucide-react";
import { computeScore } from "../ScoreCard";
import { ComparisonMetric } from "./ComparisonMetric";

interface DistrictResult {
    district: string;
    data: DashboardExport | null;
    isLoading: boolean;
    error: string | null;
}

interface ComparisonGridProps {
    results: DistrictResult[];
}

const GRADE_COLORS: Record<string, string> = {
    A: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
    B: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
    C: "text-amber-400 border-amber-500/30 bg-amber-500/10",
    D: "text-orange-400 border-orange-500/30 bg-orange-500/10",
    F: "text-red-400 border-red-500/30 bg-red-500/10",
};

function formatCzk(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return "--";
    }

    return `${value.toLocaleString("cs-CZ")} CZK`;
}

function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return "--";
    }

    return `${value.toFixed(1)}%`;
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
        .map((v, i) => (v !== null && v !== undefined ? { v, i } : null))
        .filter((x): x is { v: number; i: number } => x !== null);

    if (valid.length < 2) {
        return { bestIndex: null, worstIndex: null };
    }

    const sorted = [...valid].sort((a, b) => (higherIsBetter ? b.v - a.v : a.v - b.v));
    return { bestIndex: sorted[0].i, worstIndex: sorted[sorted.length - 1].i };
}

function getTrendDirection(data: DashboardExport): string {
    const trends = data.analysis.trends;

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

function DistrictLoadingSkeleton({ district }: { district: string }) {
    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-mono text-gray-400">{district}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <Skeleton variant="text" className="h-4 w-3/4" />
                <Skeleton variant="text" className="h-4 w-1/2" />
                <Skeleton variant="text" className="h-4 w-2/3" />
                <Skeleton variant="text" className="h-4 w-1/2" />
                <Skeleton variant="text" className="h-4 w-3/5" />
            </CardContent>
        </Card>
    );
}

function DistrictErrorCard({ district, error }: { district: string; error: string }) {
    return (
        <Card className="border-red-500/20 bg-red-500/5">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-mono text-gray-400">{district}</CardTitle>
            </CardHeader>
            <CardContent>
                <p className="text-xs font-mono text-red-400">{error}</p>
            </CardContent>
        </Card>
    );
}

export function ComparisonGrid({ results }: ComparisonGridProps) {
    const anyLoading = results.some((r) => r.isLoading);
    const loadedResults = results.filter((r) => r.data && !r.isLoading && !r.error);

    if (anyLoading) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {results.map((r) =>
                    r.isLoading ? (
                        <DistrictLoadingSkeleton key={r.district} district={r.district} />
                    ) : r.error ? (
                        <DistrictErrorCard key={r.district} district={r.district} error={r.error} />
                    ) : null
                )}
            </div>
        );
    }

    if (loadedResults.length === 0) {
        return null;
    }

    const scores = loadedResults.map((r) => {
        if (!r.data) {
            return null;
        }

        const { grade } = computeScore(r.data);
        return grade;
    });

    const medians = loadedResults.map((r) => r.data?.analysis.comparables.median ?? null);
    const yields = loadedResults.map((r) => r.data?.analysis.yield.netYield ?? null);
    const daysOnMarket = loadedResults.map((r) => r.data?.analysis.timeOnMarket.median ?? null);
    const discounts = loadedResults.map((r) => r.data?.analysis.discount.medianDiscount ?? null);
    const directions = loadedResults.map((r) => (r.data ? getTrendDirection(r.data) : "stable"));

    const medianBW = findBestWorst(medians, false);
    const yieldBW = findBestWorst(yields, true);
    const daysBW = findBestWorst(daysOnMarket, false);
    const discountBW = findBestWorst(discounts, true);

    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                    <BarChart3 className="w-4 h-4" />
                    Side-by-side Comparison
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-0">
                {/* District headers */}
                <div
                    className="grid gap-2 mb-2"
                    style={{ gridTemplateColumns: `140px repeat(${loadedResults.length}, 1fr)` }}
                >
                    <div />
                    {loadedResults.map((r, i) => (
                        <div key={r.district} className="text-center py-2">
                            <span className="text-sm font-mono font-bold text-gray-200">{r.district}</span>
                            {scores[i] && (
                                <Badge
                                    variant="outline"
                                    className={`ml-2 text-xs ${GRADE_COLORS[scores[i] ?? "?"] ?? "text-gray-400"}`}
                                >
                                    {scores[i]}
                                </Badge>
                            )}
                        </div>
                    ))}
                </div>

                {/* Metrics */}
                <ComparisonMetric
                    label="Median CZK/m2"
                    icon={<BarChart3 className="w-3 h-3" />}
                    values={loadedResults.map((r, i) => ({
                        district: r.district,
                        value: medians[i],
                        formatted: formatCzk(medians[i]),
                    }))}
                    bestIndex={medianBW.bestIndex}
                    worstIndex={medianBW.worstIndex}
                />

                <ComparisonMetric
                    label="Net Yield"
                    icon={<Percent className="w-3 h-3" />}
                    values={loadedResults.map((r, i) => ({
                        district: r.district,
                        value: yields[i],
                        formatted: formatPercent(yields[i]),
                    }))}
                    bestIndex={yieldBW.bestIndex}
                    worstIndex={yieldBW.worstIndex}
                />

                <ComparisonMetric
                    label="Days on Market"
                    icon={<Calendar className="w-3 h-3" />}
                    values={loadedResults.map((r, i) => ({
                        district: r.district,
                        value: daysOnMarket[i],
                        formatted: formatDays(daysOnMarket[i]),
                    }))}
                    bestIndex={daysBW.bestIndex}
                    worstIndex={daysBW.worstIndex}
                />

                <ComparisonMetric
                    label="Median Discount"
                    icon={<ShieldCheck className="w-3 h-3" />}
                    values={loadedResults.map((r, i) => ({
                        district: r.district,
                        value: discounts[i],
                        formatted: formatPercent(discounts[i]),
                    }))}
                    bestIndex={discountBW.bestIndex}
                    worstIndex={discountBW.worstIndex}
                />

                <ComparisonMetric
                    label="Trend"
                    icon={<TrendingUp className="w-3 h-3" />}
                    values={loadedResults.map((r, i) => ({
                        district: r.district,
                        value: directions[i],
                        formatted: directions[i],
                    }))}
                    bestIndex={null}
                    worstIndex={null}
                />

                {/* Trend direction icons row */}
                <div
                    className="grid gap-2"
                    style={{ gridTemplateColumns: `140px repeat(${loadedResults.length}, 1fr)` }}
                >
                    <div />
                    {directions.map((dir, i) => (
                        <div key={loadedResults[i].district} className="flex items-center justify-center py-1">
                            <TrendIcon direction={dir} />
                            <span className="text-[10px] font-mono text-gray-500 ml-1">{dir}</span>
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}
