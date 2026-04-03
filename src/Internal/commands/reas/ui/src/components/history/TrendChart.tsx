import { ChartContainer, ChartTooltipContent, chartAxisProps, chartGridProps } from "@ui/graphs";
import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { normalizeTrendChartData, type TrendChartPoint } from "./trend-chart-utils";

interface TrendChartProps {
    data: TrendChartPoint[];
    height?: number;
    rows?: TrendChartRow[];
    series?: TrendChartSeries[];
}

interface TrendChartSeries {
    district: string;
    color: string;
}

interface TrendChartRow {
    date: string;
    [district: string]: number | string | undefined;
}

const DISTRICT_COLORS = ["#f59e0b", "#06b6d4", "#10b981", "#a855f7", "#f43f5e", "#38bdf8"];

function formatAxisValue(value: number): string {
    if (value >= 1000) {
        return `${(value / 1000).toFixed(0)}k`;
    }

    return value.toFixed(0);
}

export function TrendChart({ data, height = 200, rows, series }: TrendChartProps) {
    const normalizedData = useMemo(() => normalizeTrendChartData(data), [data]);

    const fallbackModel = useMemo(() => {
        const districtSet = new Set<string>();
        const rowsByDate = new Map<string, TrendChartRow>();

        for (const point of normalizedData) {
            districtSet.add(point.district);

            const existingRow = rowsByDate.get(point.date) ?? {
                date: point.date,
            };

            existingRow[point.district] = point.value;
            rowsByDate.set(point.date, existingRow);
        }

        return {
            rows: [...rowsByDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
            series: [...districtSet].map((district, index) => ({
                district,
                color: DISTRICT_COLORS[index % DISTRICT_COLORS.length],
            })),
        };
    }, [normalizedData]);

    const resolvedRows = rows ?? fallbackModel.rows;
    const resolvedSeries = series ?? fallbackModel.series;
    const showDots = resolvedRows.length <= 12;

    if (resolvedRows.length === 0 || resolvedSeries.length === 0) {
        return (
            <div className="flex items-center justify-center border border-white/5 rounded-lg" style={{ height }}>
                <p className="text-xs font-mono text-gray-500">No snapshot data available</p>
            </div>
        );
    }

    return (
        <div className="relative">
            <ChartContainer
                title="District trend chart"
                description="Median CZK per m² over time"
                height={height}
                className="border-none bg-transparent p-0"
            >
                <LineChart data={resolvedRows} margin={{ top: 8, right: 12, bottom: 12, left: 8 }}>
                    <CartesianGrid {...chartGridProps} />
                    <XAxis {...chartAxisProps} dataKey="date" tickFormatter={(value: string) => value.slice(5)} />
                    <YAxis {...chartAxisProps} tickFormatter={(value: number) => formatAxisValue(value)} width={56} />
                    <Tooltip
                        content={
                            <ChartTooltipContent
                                valueFormatter={(value) => `${Number(value ?? 0).toLocaleString("cs-CZ")} CZK/m²`}
                            />
                        }
                    />
                    {resolvedSeries.map((item) => (
                        <Line
                            key={item.district}
                            type="monotone"
                            dataKey={item.district}
                            name={item.district}
                            stroke={item.color}
                            strokeWidth={3}
                            connectNulls
                            dot={
                                showDots
                                    ? {
                                          r: 3,
                                          fill: item.color,
                                          stroke: "#0f172a",
                                          strokeWidth: 1.5,
                                      }
                                    : false
                            }
                            activeDot={{ r: 5, fill: item.color }}
                        />
                    ))}
                </LineChart>
            </ChartContainer>

            {resolvedSeries.length > 0 && (
                <div className="flex items-center gap-4 mt-2 justify-center">
                    {resolvedSeries.map((item) => (
                        <div
                            key={item.district}
                            className="flex items-center gap-1.5 text-[10px] font-mono text-gray-400"
                        >
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                            {item.district}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
