import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { TrendingDown, TrendingUp } from "lucide-react";
import { useMemo } from "react";

interface PriceTrendChartProps {
    data: DashboardExport;
}

interface ChartPoint {
    label: string;
    value: number;
    count: number;
    change: number | null | undefined;
}

const CHART_HEIGHT = 160;
const CHART_PADDING = { top: 20, right: 20, bottom: 40, left: 60 };

function formatAxisValue(v: number): string {
    if (v >= 1000) {
        return `${(v / 1000).toFixed(0)}k`;
    }

    return v.toFixed(0);
}

export function PriceTrendChart({ data }: PriceTrendChartProps) {
    const trends = data.analysis.trends;

    const points: ChartPoint[] = useMemo(
        () =>
            trends.map((t) => ({
                label: t.period,
                value: t.medianPricePerM2,
                count: t.count,
                change: t.qoqChange,
            })),
        [trends]
    );

    const { yoyChange, yoyLabel } = useMemo(() => {
        if (points.length < 2) {
            return { yoyChange: 0, yoyLabel: "N/A" };
        }

        const first = points[0].value;
        const last = points[points.length - 1].value;
        const change = first > 0 ? ((last - first) / first) * 100 : 0;
        return {
            yoyChange: change,
            yoyLabel: `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`,
        };
    }, [points]);

    if (points.length === 0) {
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

    const values = points.map((p) => p.value);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal || 1;
    const yPadding = range * 0.1;
    const yMin = minVal - yPadding;
    const yMax = maxVal + yPadding;

    const width = 600;
    const plotWidth = width - CHART_PADDING.left - CHART_PADDING.right;
    const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

    function xPos(i: number): number {
        if (points.length === 1) {
            return CHART_PADDING.left + plotWidth / 2;
        }

        return CHART_PADDING.left + (i / (points.length - 1)) * plotWidth;
    }

    function yPos(v: number): number {
        return CHART_PADDING.top + plotHeight - ((v - yMin) / (yMax - yMin)) * plotHeight;
    }

    // Build path
    const linePoints = points.map((p, i) => `${xPos(i)},${yPos(p.value)}`).join(" ");
    const areaPoints = [
        ...points.map((p, i) => `${xPos(i)},${yPos(p.value)}`),
        `${xPos(points.length - 1)},${CHART_PADDING.top + plotHeight}`,
        `${xPos(0)},${CHART_PADDING.top + plotHeight}`,
    ].join(" ");

    // Y-axis ticks
    const tickCount = 4;
    const yTicks = Array.from({ length: tickCount }, (_, i) => {
        const frac = i / (tickCount - 1);
        return yMin + frac * (yMax - yMin);
    });

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
                <svg
                    viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                    className="w-full"
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label="Price trend chart showing median CZK per m² over time"
                >
                    <defs>
                        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="rgb(6 182 212)" stopOpacity="0.3" />
                            <stop offset="100%" stopColor="rgb(6 182 212)" stopOpacity="0.02" />
                        </linearGradient>
                    </defs>

                    {/* Grid lines */}
                    {yTicks.map((tick) => (
                        <g key={tick}>
                            <line
                                x1={CHART_PADDING.left}
                                y1={yPos(tick)}
                                x2={width - CHART_PADDING.right}
                                y2={yPos(tick)}
                                stroke="rgba(255,255,255,0.05)"
                                strokeDasharray="4 4"
                            />
                            <text
                                x={CHART_PADDING.left - 8}
                                y={yPos(tick) + 3}
                                textAnchor="end"
                                fill="rgba(255,255,255,0.3)"
                                fontSize="9"
                                fontFamily="monospace"
                            >
                                {formatAxisValue(tick)}
                            </text>
                        </g>
                    ))}

                    {/* Area fill */}
                    <polygon points={areaPoints} fill="url(#areaGradient)" />

                    {/* Line */}
                    <polyline
                        points={linePoints}
                        fill="none"
                        stroke="rgb(6 182 212)"
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />

                    {/* Data points + labels */}
                    {points.map((p, i) => (
                        <g key={p.label}>
                            {/* Dot */}
                            <circle
                                cx={xPos(i)}
                                cy={yPos(p.value)}
                                r="3.5"
                                fill="rgb(6 182 212)"
                                stroke="rgba(10,10,20,0.9)"
                                strokeWidth="2"
                            />
                            {/* Glow */}
                            <circle
                                cx={xPos(i)}
                                cy={yPos(p.value)}
                                r="6"
                                fill="none"
                                stroke="rgba(6,182,212,0.2)"
                                strokeWidth="1"
                            />

                            {/* X-axis label */}
                            <text
                                x={xPos(i)}
                                y={CHART_HEIGHT - 6}
                                textAnchor="middle"
                                fill="rgba(255,255,255,0.4)"
                                fontSize="9"
                                fontFamily="monospace"
                            >
                                {p.label}
                            </text>

                            {/* Value label on hover zone */}
                            <text
                                x={xPos(i)}
                                y={yPos(p.value) - 10}
                                textAnchor="middle"
                                fill="rgba(6,182,212,0.8)"
                                fontSize="8"
                                fontFamily="monospace"
                            >
                                {formatAxisValue(p.value)}
                            </text>
                        </g>
                    ))}
                </svg>
            </CardContent>
        </Card>
    );
}
