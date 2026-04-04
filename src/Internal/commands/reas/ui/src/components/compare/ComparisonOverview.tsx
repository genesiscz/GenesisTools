import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { ArrowDownRight, ArrowUpRight, BarChart3, Clock3, Percent } from "lucide-react";
import { fmt, pct } from "../../lib/format";
import { GRADE_COLORS, getScoreCardModel } from "../analysis/display-model";
import { ExportButton } from "../ExportButton";
import type { DistrictComparison } from "./types";

interface ComparisonOverviewProps {
    comparisons: DistrictComparison[];
}

export function ComparisonOverview({ comparisons }: ComparisonOverviewProps) {
    return (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {comparisons.map((comparison) => {
                const { exportData, snapshots, summary } = comparison;
                const { grade, score } = getScoreCardModel(exportData);
                const latestSnapshot = snapshots[snapshots.length - 1] ?? null;
                const yoyChange = latestSnapshot?.yoyChange ?? null;
                const trendDirection =
                    latestSnapshot?.trendDirection ?? exportData.analysis.momentum?.direction ?? "stable";

                return (
                    <Card key={comparison.district} className="border-white/5 bg-white/[0.02]">
                        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="space-y-2">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <CardTitle className="text-base font-mono text-gray-100">
                                        {comparison.district}
                                    </CardTitle>
                                    <Badge
                                        variant="outline"
                                        className={cn("font-mono text-[10px]", GRADE_COLORS[grade])}
                                    >
                                        Grade {grade}
                                    </Badge>
                                    <Badge
                                        variant="outline"
                                        className="font-mono text-[10px] border-white/10 text-gray-400"
                                    >
                                        Score {score}
                                    </Badge>
                                </div>
                                <p className="text-xs font-mono text-gray-500">
                                    {exportData.meta.target.constructionType} · {exportData.meta.target.disposition}
                                </p>
                            </div>
                            <ExportButton data={exportData} />
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <OverviewStat
                                    label="Median Price"
                                    value={`${fmt(Math.round(summary.medianPricePerM2))} CZK/m²`}
                                    icon={<BarChart3 className="w-3.5 h-3.5 text-cyan-400" />}
                                />
                                <OverviewStat
                                    label="Net Yield"
                                    value={pct(summary.netYield, { digits: 2 })}
                                    icon={<Percent className="w-3.5 h-3.5 text-emerald-400" />}
                                />
                                <OverviewStat
                                    label="Days on Market"
                                    value={`${Math.round(summary.daysOnMarket)}d`}
                                    icon={<Clock3 className="w-3.5 h-3.5 text-amber-400" />}
                                />
                            </div>

                            <div className="flex flex-wrap gap-2">
                                <MetaBadge
                                    label="Target percentile"
                                    value={`${summary.targetPercentile.toFixed(0)}th`}
                                />
                                <MetaBadge label="Sold comps" value={String(summary.salesCount)} />
                                <MetaBadge label="Rental comps" value={String(summary.rentalCount)} />
                                <MetaBadge label="Trend" value={trendDirection} />
                                {yoyChange !== null && (
                                    <Badge
                                        variant="outline"
                                        className={cn(
                                            "font-mono text-[10px]",
                                            yoyChange >= 0
                                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                                : "border-red-500/30 bg-red-500/10 text-red-300"
                                        )}
                                    >
                                        {yoyChange >= 0 ? (
                                            <ArrowUpRight className="w-3 h-3 mr-1" />
                                        ) : (
                                            <ArrowDownRight className="w-3 h-3 mr-1" />
                                        )}
                                        YoY {yoyChange >= 0 ? "+" : ""}
                                        {yoyChange.toFixed(1)}%
                                    </Badge>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                );
            })}
        </div>
    );
}

function OverviewStat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
    return (
        <div className="rounded-lg border border-white/5 bg-black/20 p-3">
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-gray-500">
                {icon}
                {label}
            </div>
            <div className="mt-2 text-sm font-mono font-semibold text-gray-100">{value}</div>
        </div>
    );
}

function MetaBadge({ label, value }: { label: string; value: string }) {
    return (
        <Badge variant="outline" className="font-mono text-[10px] border-white/10 text-gray-400 bg-black/20">
            {label}: <span className="ml-1 text-gray-200">{value}</span>
        </Badge>
    );
}
