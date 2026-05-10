import type { PriceHistoryResponse } from "@app/shops/types";
import { ChartBox } from "@app/shops/ui/components/ChartBox";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { chartColors, chartSeriesPalette } from "@app/utils/ui/graphs/colors";
import { Area, AreaChart, CartesianGrid, Legend, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

interface PriceHistoryChartProps {
    history: PriceHistoryResponse | undefined;
    isLoading: boolean;
    targetPrice?: number | null;
    referencePrice?: number | null;
}

export function PriceHistoryChart({ history, isLoading, targetPrice, referencePrice }: PriceHistoryChartProps) {
    return (
        <Card className="overflow-hidden">
            <CardHeader>
                <CardTitle className="font-mono text-xs tracking-[0.25em] text-muted-foreground">
                    PRICE HISTORY
                </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
                {isLoading ? (
                    <div className="h-72 flex items-center justify-center text-muted-foreground font-mono text-xs">
                        loading…
                    </div>
                ) : !history || history.points.length === 0 ? (
                    <div className="h-72 flex items-center justify-center text-muted-foreground font-mono text-xs tracking-[0.2em]">
                        NO HISTORY YET
                    </div>
                ) : (
                    <ChartBox height={288}>
                        {({ width, height }) => (
                            <AreaChart
                                data={history.points}
                                width={width}
                                height={height}
                                margin={{ top: 10, right: 24, left: 0, bottom: 0 }}
                            >
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
                                {targetPrice ? (
                                    <ReferenceLine
                                        y={targetPrice}
                                        stroke="var(--color-neon-amber)"
                                        strokeDasharray="4 2"
                                        label={{
                                            value: "target",
                                            fontSize: 10,
                                            fill: "var(--color-neon-amber)",
                                        }}
                                    />
                                ) : null}
                                {referencePrice ? (
                                    <ReferenceLine
                                        y={referencePrice}
                                        stroke={chartColors.axis}
                                        strokeDasharray="2 2"
                                        label={{ value: "ref", fontSize: 10, fill: chartColors.axis }}
                                    />
                                ) : null}
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
                        )}
                    </ChartBox>
                )}
            </CardContent>
        </Card>
    );
}
