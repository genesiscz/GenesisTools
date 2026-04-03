import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { ChartContainer, ChartTooltipContent, chartAxisProps, chartGridProps } from "@ui/graphs";
import { cn } from "@ui/lib/utils";
import { TrendingDown, TrendingUp } from "lucide-react";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { buildPriceTrendModel } from "./price-trend-model";

interface PriceTrendChartProps {
    data: DashboardExport;
}

function formatAxisValue(v: number): string {
    if (v >= 1000) {
        return `${(v / 1000).toFixed(0)}k`;
    }

    return v.toFixed(0);
}

export function PriceTrendChart({ data }: PriceTrendChartProps) {
    const { points, yoyChange, yoyLabel, isEmpty } = buildPriceTrendModel(data.analysis.trends);

    if (isEmpty) {
        return (
            <Card className="border-white/5">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm font-mono">
                        <TrendingUp className="h-4 w-4 text-amber-400" />
                        Price Trend
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-xs text-muted-foreground font-mono text-center py-8">No trend data available</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="border-white/5">
            <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-sm font-mono">
                    <TrendingUp className="h-4 w-4 text-amber-400" />
                    Price Trend
                    <Badge
                        className={cn(
                            "ml-2 font-mono text-[10px]",
                            yoyChange >= 0
                                ? "bg-green-500/15 border-green-500/30 text-green-400"
                                : "bg-red-500/15 border-red-500/30 text-red-400"
                        )}
                    >
                        {yoyChange >= 0 ? (
                            <TrendingUp className="h-3 w-3 mr-0.5" />
                        ) : (
                            <TrendingDown className="h-3 w-3 mr-0.5" />
                        )}
                        {yoyLabel}
                    </Badge>
                </CardTitle>
            </CardHeader>
            <CardContent>
                <ChartContainer
                    title="Price Trend"
                    description="Median CZK per m² over time"
                    height={220}
                    className="border-none bg-transparent p-0"
                >
                    <LineChart data={points} margin={{ top: 8, right: 12, bottom: 12, left: 8 }}>
                        <CartesianGrid {...chartGridProps} />
                        <XAxis {...chartAxisProps} dataKey="label" />
                        <YAxis
                            {...chartAxisProps}
                            tickFormatter={(value: number) => formatAxisValue(value)}
                            width={56}
                        />
                        <Tooltip
                            content={
                                <ChartTooltipContent
                                    valueFormatter={(value, name) => {
                                        if (name === "Median CZK / m²") {
                                            return `${formatAxisValue(Number(value ?? 0))} CZK`;
                                        }

                                        if (name === "Comparable Count") {
                                            return String(value ?? "-");
                                        }

                                        return String(value ?? "-");
                                    }}
                                />
                            }
                        />
                        <Line
                            type="monotone"
                            dataKey="value"
                            name="Median CZK / m²"
                            stroke="rgb(6 182 212)"
                            strokeWidth={3}
                            dot={{ r: 4, fill: "rgb(6 182 212)", stroke: "#0f172a", strokeWidth: 2 }}
                            activeDot={{ r: 5, fill: "rgb(245 158 11)" }}
                        />
                        <Line
                            type="monotone"
                            dataKey="count"
                            name="Comparable Count"
                            stroke="rgba(245,158,11,0.7)"
                            strokeWidth={2}
                            dot={false}
                        />
                    </LineChart>
                </ChartContainer>
            </CardContent>
        </Card>
    );
}
