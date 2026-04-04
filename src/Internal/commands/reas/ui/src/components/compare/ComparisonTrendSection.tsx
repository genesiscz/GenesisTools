import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Activity, ArrowDownRight, ArrowUpRight, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TrendChart } from "../history/TrendChart";
import { buildDistrictTrendModel, DISTRICT_TREND_TIMEFRAMES } from "./district-trend-model";
import type { DistrictComparison } from "./types";

interface ComparisonTrendSectionProps {
    comparisons: DistrictComparison[];
    snapshotResolution: "daily" | "monthly";
}

export function ComparisonTrendSection({ comparisons, snapshotResolution }: ComparisonTrendSectionProps) {
    const availableDistricts = useMemo(() => comparisons.map((comparison) => comparison.district), [comparisons]);
    const [timeframeDays, setTimeframeDays] = useState<number>(DISTRICT_TREND_TIMEFRAMES[2].days);
    const [visibleDistricts, setVisibleDistricts] = useState<string[]>(availableDistricts);

    useEffect(() => {
        setVisibleDistricts((prev) => {
            const next = prev.filter((district) => availableDistricts.includes(district));

            if (next.length > 0) {
                return next;
            }

            return availableDistricts;
        });
    }, [availableDistricts]);

    const model = useMemo(
        () =>
            buildDistrictTrendModel({
                comparisons,
                timeframeDays,
                visibleDistricts,
            }),
        [comparisons, timeframeDays, visibleDistricts]
    );

    function toggleDistrict(district: string) {
        setVisibleDistricts((prev) => {
            if (prev.includes(district)) {
                if (prev.length === 1) {
                    return prev;
                }

                return prev.filter((value) => value !== district);
            }

            return [...prev, district];
        });
    }

    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader>
                <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    Multi-district trendline
                </CardTitle>
            </CardHeader>
            <CardContent className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="flex min-w-0 flex-col gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                        {DISTRICT_TREND_TIMEFRAMES.map((timeframe) => (
                            <button
                                key={timeframe.days}
                                type="button"
                                onClick={() => setTimeframeDays(timeframe.days)}
                                aria-pressed={timeframeDays === timeframe.days}
                                className={cn(
                                    "rounded-md border px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors",
                                    timeframeDays === timeframe.days
                                        ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-300"
                                        : "border-white/10 bg-black/20 text-gray-500 hover:border-white/20 hover:text-gray-300"
                                )}
                            >
                                {timeframe.label}
                            </button>
                        ))}
                    </div>
                    <div className="rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-[10px] font-mono uppercase tracking-[0.24em] text-gray-400">
                        {snapshotResolution === "monthly"
                            ? "Monthly snapshots loaded for smoother district overlays"
                            : "Daily snapshots loaded for high-frequency market reads"}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {availableDistricts.map((district) => {
                            const isVisible = visibleDistricts.includes(district);

                            return (
                                <button
                                    key={district}
                                    type="button"
                                    onClick={() => toggleDistrict(district)}
                                    aria-pressed={isVisible}
                                    className={cn(
                                        "rounded-md border px-2.5 py-1 text-[10px] font-mono transition-colors",
                                        isVisible
                                            ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                                            : "border-white/10 bg-black/20 text-gray-500 hover:border-white/20 hover:text-gray-300"
                                    )}
                                >
                                    {district}
                                </button>
                            );
                        })}
                    </div>
                    <TrendChart data={[]} rows={model.rows} series={model.series} height={260} />
                </div>
                <div className="flex min-w-0 flex-col gap-3">
                    {model.series.map((series) => {
                        const comparison = comparisons.find((item) => item.district === series.district);
                        const latestSnapshot = comparison?.snapshots[comparison.snapshots.length - 1] ?? null;
                        const yoyChange = series.yoyChange;

                        return (
                            <div
                                key={series.district}
                                className="flex flex-col gap-2 rounded-lg border border-white/5 bg-black/20 p-3"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-mono font-semibold text-gray-100">
                                            {series.district}
                                        </div>
                                        <div className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                                            Latest snapshot {series.latestDate ?? "N/A"}
                                        </div>
                                    </div>
                                    <Activity className="w-4 h-4" style={{ color: series.color }} />
                                </div>
                                <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                                    <MetricPair
                                        label="Median"
                                        value={
                                            series.latestValue === null
                                                ? "N/A"
                                                : `${Math.round(series.latestValue).toLocaleString("cs-CZ")} CZK/m²`
                                        }
                                    />
                                    <MetricPair
                                        label="Comparables"
                                        value={String(
                                            latestSnapshot?.comparablesCount ?? comparison?.summary.salesCount ?? 0
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
