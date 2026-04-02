import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Percent, PiggyBank } from "lucide-react";

interface YieldCardProps {
    data: DashboardExport;
}

function toFiniteNumber(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }

    return value;
}

function formatYield(v: number | null | undefined): string {
    const value = toFiniteNumber(v);

    if (value === null) {
        return "--";
    }

    return `${value.toFixed(2)}%`;
}

function yieldColor(v: number | null | undefined): string {
    const value = toFiniteNumber(v);

    if (value === null) {
        return "text-gray-500";
    }

    if (value >= 5) {
        return "text-green-400";
    }

    if (value >= 3.5) {
        return "text-amber-400";
    }

    return "text-red-400";
}

export function YieldCard({ data }: YieldCardProps) {
    const { grossYield, netYield, paybackYears, atMarketPrice } = data.analysis.yield;
    const benchmarks = data.benchmarks.investmentBenchmarks;
    const paybackYearsValue = toFiniteNumber(paybackYears);
    const marketPrice = toFiniteNumber(atMarketPrice.price);
    const marketPaybackYears = toFiniteNumber(atMarketPrice.paybackYears);
    const marketGrossYield = toFiniteNumber(atMarketPrice.grossYield);
    const marketNetYield = toFiniteNumber(atMarketPrice.netYield);
    const netYieldValue = toFiniteNumber(netYield);

    return (
        <Card className="border-white/5">
            <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-sm font-mono">
                    <Percent className="h-4 w-4 text-amber-400" />
                    Yield Analysis
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Main yields */}
                <div className="grid grid-cols-2 gap-4">
                    <YieldMetric label="Gross Yield" value={grossYield} />
                    <YieldMetric label="Net Yield" value={netYield} />
                </div>

                {/* Payback */}
                <div className="flex items-center justify-between rounded-md border border-white/5 bg-white/[0.02] px-3 py-2">
                    <span className="flex items-center gap-2 text-xs font-mono text-gray-400">
                        <PiggyBank className="h-3.5 w-3.5 text-cyan-400" />
                        Payback Period
                    </span>
                    <span className="text-sm font-mono font-bold text-foreground">
                        {paybackYearsValue === null ? "--" : `${paybackYearsValue.toFixed(1)} years`}
                    </span>
                </div>

                {/* At market price comparison */}
                <div className="rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 space-y-1.5">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-gray-600">
                        {marketPrice === null
                            ? "At Market Price"
                            : `At Market Price (${(marketPrice / 1_000_000).toFixed(1)}M CZK)`}
                    </span>
                    <div className="flex items-center gap-4 text-xs font-mono">
                        <span className="text-gray-500">
                            Gross: <span className={yieldColor(marketGrossYield)}>{formatYield(marketGrossYield)}</span>
                        </span>
                        <span className="text-gray-500">
                            Net: <span className={yieldColor(marketNetYield)}>{formatYield(marketNetYield)}</span>
                        </span>
                        <span className="text-gray-500">
                            Payback:{" "}
                            <span className="text-foreground">
                                {marketPaybackYears === null ? "--" : `${marketPaybackYears.toFixed(1)}y`}
                            </span>
                        </span>
                    </div>
                </div>

                {/* Benchmarks */}
                {benchmarks.length > 0 && (
                    <div className="space-y-1.5">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-600">
                            vs Benchmarks
                        </span>
                        <div className="flex flex-wrap gap-2">
                            {benchmarks.map((b) => {
                                const diff = netYieldValue === null ? null : netYieldValue - b.annualReturn;

                                return (
                                    <Badge
                                        key={b.name}
                                        variant="outline"
                                        className={cn(
                                            "font-mono text-[10px] border-white/10",
                                            diff === null
                                                ? "text-gray-400"
                                                : diff > 0
                                                  ? "text-green-400"
                                                  : "text-red-400"
                                        )}
                                    >
                                        {b.name}: {b.annualReturn}%
                                        {diff !== null && (
                                            <span className="ml-1 opacity-70">
                                                ({diff >= 0 ? "+" : ""}
                                                {diff.toFixed(1)}%)
                                            </span>
                                        )}
                                    </Badge>
                                );
                            })}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function YieldMetric({ label, value }: { label: string; value: number | null | undefined }) {
    return (
        <div className="rounded-md border border-white/5 bg-white/[0.02] p-3 text-center">
            <div className={cn("text-xl font-bold font-mono", yieldColor(value))}>{formatYield(value)}</div>
            <div className="mt-1 text-[10px] font-mono text-gray-500 uppercase tracking-wider">{label}</div>
        </div>
    );
}
