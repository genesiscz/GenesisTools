import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Activity, ArrowDownRight, ArrowUpRight, TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { TrendChart } from "../history/TrendChart";
import type { DistrictComparison } from "./types";

interface ComparisonTrendSectionProps {
    comparisons: DistrictComparison[];
}

export function ComparisonTrendSection({ comparisons }: ComparisonTrendSectionProps) {
    const chartData = useMemo(
        () =>
            comparisons.flatMap((comparison) =>
                comparison.snapshots.map((snapshot) => ({
                    date: snapshot.snapshotDate,
                    value: snapshot.medianPricePerM2,
                    district: comparison.district,
                }))
            ),
        [comparisons]
    );

    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader>
                <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    Multi-district trendline
                </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
                <TrendChart data={chartData} height={260} />
                <div className="space-y-3">
                    {comparisons.map((comparison) => {
                        const latestSnapshot = comparison.snapshots[comparison.snapshots.length - 1] ?? null;
                        const yoyChange = latestSnapshot?.yoyChange ?? null;

                        return (
                            <div
                                key={comparison.district}
                                className="rounded-lg border border-white/5 bg-black/20 p-3 space-y-2"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-mono font-semibold text-gray-100">
                                            {comparison.district}
                                        </div>
                                        <div className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                                            Latest snapshot {latestSnapshot?.snapshotDate ?? "N/A"}
                                        </div>
                                    </div>
                                    <Activity className="w-4 h-4 text-cyan-400" />
                                </div>
                                <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                                    <MetricPair
                                        label="Median"
                                        value={`${Math.round(comparison.summary.medianPricePerM2).toLocaleString("cs-CZ")} CZK/m²`}
                                    />
                                    <MetricPair
                                        label="Comparables"
                                        value={String(
                                            latestSnapshot?.comparablesCount ?? comparison.summary.salesCount
                                        )}
                                    />
                                </div>
                                <div
                                    className={cn(
                                        "flex items-center gap-2 text-xs font-mono rounded-md px-2.5 py-2 border",
                                        yoyChange === null
                                            ? "border-white/10 text-gray-500"
                                            : yoyChange >= 0
                                              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                                              : "border-red-500/20 bg-red-500/10 text-red-300"
                                    )}
                                >
                                    {yoyChange === null ? null : yoyChange >= 0 ? (
                                        <ArrowUpRight className="w-3.5 h-3.5" />
                                    ) : (
                                        <ArrowDownRight className="w-3.5 h-3.5" />
                                    )}
                                    {yoyChange === null
                                        ? "YoY change unavailable"
                                        : `YoY ${yoyChange >= 0 ? "+" : ""}${yoyChange.toFixed(1)}%`}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </CardContent>
        </Card>
    );
}

function MetricPair({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
            <div className="mt-1 text-gray-200">{value}</div>
        </div>
    );
}
