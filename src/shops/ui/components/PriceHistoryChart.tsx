import type { PriceHistoryResponse } from "@app/shops/types";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { chartColors, chartSeriesPalette } from "@app/utils/ui/graphs/colors";
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface PriceHistoryChartProps {
    history: PriceHistoryResponse | undefined;
    isLoading: boolean;
}

export function PriceHistoryChart({ history, isLoading }: PriceHistoryChartProps) {
    return (
        <Card className="overflow-hidden">
            <CardHeader>
                <CardTitle className="font-mono text-xs tracking-[0.25em] text-muted-foreground">
                    PRICE HISTORY
                </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
                <div className="h-72 w-full">
                    {isLoading ? (
                        <div className="h-full flex items-center justify-center text-muted-foreground font-mono text-xs">
                            loading…
                        </div>
                    ) : !history || history.points.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-muted-foreground font-mono text-xs tracking-[0.2em]">
                            NO HISTORY YET
                        </div>
                    ) : (
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={history.points} margin={{ top: 10, right: 24, left: 0, bottom: 0 }}>
                                <defs>
                                    {history.shops.map((shop, i) => {
                                        const color = chartSeriesPalette[i % chartSeriesPalette.length];
                                        return (
                                            <linearGradient key={shop} id={`grad-${shop}`} x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="0%" stopColor={color} stopOpacity={0.45} />
                                                <stop offset="100%" stopColor={color} stopOpacity={0.04} />
                                            </linearGradient>
                                        );
                                    })}
                                </defs>
                                <CartesianGrid stroke={chartColors.grid} strokeDasharray="3 3" />
                                <XAxis
                                    dataKey="date"
                                    stroke={chartColors.axis}
                                    tick={{ fontSize: 10, fontFamily: "monospace" }}
                                    tickFormatter={(v: string) => v.slice(5)}
                                />
                                <YAxis
                                    stroke={chartColors.axis}
                                    tick={{ fontSize: 10, fontFamily: "monospace" }}
                                    tickFormatter={(v: number) => `${v} Kč`}
                                />
                                <Tooltip
                                    contentStyle={{
                                        background: chartColors.tooltipBg,
                                        border: `1px solid ${chartColors.tooltipBorder}`,
                                        fontFamily: "monospace",
                                        fontSize: 11,
                                    }}
                                    labelStyle={{ color: chartColors.cyan }}
                                />
                                <Legend wrapperStyle={{ fontFamily: "monospace", fontSize: 10 }} />
                                {history.shops.map((shop, i) => {
                                    const color = chartSeriesPalette[i % chartSeriesPalette.length];
                                    return (
                                        <Area
                                            key={shop}
                                            type="monotone"
                                            dataKey={shop}
                                            stroke={color}
                                            strokeWidth={1.5}
                                            fill={`url(#grad-${shop})`}
                                            connectNulls
                                        />
                                    );
                                })}
                            </AreaChart>
                        </ResponsiveContainer>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
