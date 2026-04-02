import { useCallback, useMemo, useRef, useState } from "react";
import { normalizeTrendChartData, type TrendChartPoint } from "./trend-chart-utils";

interface TrendChartProps {
    data: TrendChartPoint[];
    height?: number;
}

const DISTRICT_COLORS = [
    "#f59e0b", // amber
    "#06b6d4", // cyan
    "#10b981", // emerald
    "#a855f7", // purple
    "#f43f5e", // rose
];

interface TooltipState {
    x: number;
    y: number;
    date: string;
    entries: Array<{ district: string; value: number; color: string }>;
}

export function TrendChart({ data, height = 200 }: TrendChartProps) {
    const svgRef = useRef<SVGSVGElement>(null);
    const [tooltip, setTooltip] = useState<TooltipState | null>(null);
    const normalizedData = useMemo(() => normalizeTrendChartData(data), [data]);

    const WIDTH = 700;
    const PADDING = { top: 20, right: 20, bottom: 30, left: 60 };
    const chartWidth = WIDTH - PADDING.left - PADDING.right;
    const chartHeight = height - PADDING.top - PADDING.bottom;

    const { districts, dates, lines, yMin, yMax, xScale, yScale } = useMemo(() => {
        const districtSet = new Set<string>();
        const dateSet = new Set<string>();

        for (const d of normalizedData) {
            districtSet.add(d.district);
            dateSet.add(d.date);
        }

        const districtsList = [...districtSet];
        const datesList = [...dateSet].sort();

        if (datesList.length === 0 || districtsList.length === 0) {
            return {
                districts: [],
                dates: [],
                lines: [],
                yMin: 0,
                yMax: 100,
                xScale: () => 0,
                yScale: () => 0,
            };
        }

        const values = normalizedData.map((d) => d.value);
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        const padding = (maxVal - minVal) * 0.1 || 1000;
        const yMinVal = Math.floor((minVal - padding) / 1000) * 1000;
        const yMaxVal = Math.ceil((maxVal + padding) / 1000) * 1000;

        const xScaleFn = (date: string) => {
            const idx = datesList.indexOf(date);
            return PADDING.left + (idx / Math.max(datesList.length - 1, 1)) * chartWidth;
        };

        const yScaleFn = (value: number) => {
            const ratio = (value - yMinVal) / (yMaxVal - yMinVal || 1);
            return PADDING.top + chartHeight - ratio * chartHeight;
        };

        const lineData = districtsList.map((district, i) => {
            const points = normalizedData
                .filter((d) => d.district === district)
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((d) => ({
                    x: xScaleFn(d.date),
                    y: yScaleFn(d.value),
                    date: d.date,
                    value: d.value,
                }));

            const pathData = points.map((p, j) => `${j === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

            return {
                district,
                color: DISTRICT_COLORS[i % DISTRICT_COLORS.length],
                points,
                pathData,
            };
        });

        return {
            districts: districtsList,
            dates: datesList,
            lines: lineData,
            yMin: yMinVal,
            yMax: yMaxVal,
            xScale: xScaleFn,
            yScale: yScaleFn,
        };
    }, [normalizedData, chartWidth, chartHeight]);

    const yTicks = useMemo(() => {
        const count = 5;
        const step = (yMax - yMin) / count;
        return Array.from({ length: count + 1 }, (_, i) => yMin + i * step);
    }, [yMin, yMax]);

    const xTicks = useMemo(() => {
        if (dates.length <= 6) {
            return dates;
        }

        const step = Math.ceil(dates.length / 6);
        return dates.filter((_, i) => i % step === 0 || i === dates.length - 1);
    }, [dates]);

    const handleMouseMove = useCallback(
        (e: React.MouseEvent<SVGSVGElement>) => {
            const svg = svgRef.current;

            if (!svg || dates.length === 0) {
                return;
            }

            const rect = svg.getBoundingClientRect();
            const mouseX = ((e.clientX - rect.left) / rect.width) * WIDTH;

            let closestDate = dates[0];
            let closestDist = Infinity;

            for (const date of dates) {
                const x = xScale(date);
                const dist = Math.abs(x - mouseX);

                if (dist < closestDist) {
                    closestDist = dist;
                    closestDate = date;
                }
            }

            const entries = lines
                .map((line) => {
                    const point = line.points.find((p) => p.date === closestDate);

                    if (!point) {
                        return null;
                    }

                    return {
                        district: line.district,
                        value: point.value,
                        color: line.color,
                    };
                })
                .filter((e): e is NonNullable<typeof e> => e !== null);

            if (entries.length > 0) {
                setTooltip({
                    x: xScale(closestDate),
                    y: PADDING.top,
                    date: closestDate,
                    entries,
                });
            }
        },
        [dates, lines, xScale]
    );

    const handleMouseLeave = useCallback(() => {
        setTooltip(null);
    }, []);

    if (normalizedData.length === 0) {
        return (
            <div className="flex items-center justify-center border border-white/5 rounded-lg" style={{ height }}>
                <p className="text-xs font-mono text-gray-500">No snapshot data available</p>
            </div>
        );
    }

    return (
        <div className="relative">
            <svg
                ref={svgRef}
                viewBox={`0 0 ${WIDTH} ${height}`}
                className="w-full"
                role="img"
                aria-label="Price trend chart showing median CZK per square meter over time"
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}
            >
                <title>Price trend chart</title>
                {/* Grid lines */}
                {yTicks.map((tick) => (
                    <g key={`y-${tick}`}>
                        <line
                            x1={PADDING.left}
                            x2={WIDTH - PADDING.right}
                            y1={yScale(tick)}
                            y2={yScale(tick)}
                            stroke="rgba(255,255,255,0.05)"
                            strokeDasharray="4,4"
                        />
                        <text
                            x={PADDING.left - 8}
                            y={yScale(tick)}
                            textAnchor="end"
                            dominantBaseline="middle"
                            className="fill-gray-500"
                            fontSize="9"
                            fontFamily="monospace"
                        >
                            {(tick / 1000).toFixed(0)}k
                        </text>
                    </g>
                ))}

                {/* X-axis labels */}
                {xTicks.map((date) => (
                    <text
                        key={`x-${date}`}
                        x={xScale(date)}
                        y={height - 8}
                        textAnchor="middle"
                        className="fill-gray-500"
                        fontSize="9"
                        fontFamily="monospace"
                    >
                        {date.slice(5)}
                    </text>
                ))}

                {/* Lines */}
                {lines.map((line) => (
                    <g key={line.district}>
                        <path
                            d={line.pathData}
                            fill="none"
                            stroke={line.color}
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                        {line.points.map((point) => (
                            <circle
                                key={`${line.district}-${point.date}`}
                                cx={point.x}
                                cy={point.y}
                                r="3"
                                fill={line.color}
                                stroke="#0a0a14"
                                strokeWidth="1.5"
                            />
                        ))}
                    </g>
                ))}

                {/* Tooltip crosshair */}
                {tooltip && (
                    <line
                        x1={tooltip.x}
                        x2={tooltip.x}
                        y1={PADDING.top}
                        y2={height - PADDING.bottom}
                        stroke="rgba(255,255,255,0.2)"
                        strokeDasharray="2,2"
                    />
                )}
            </svg>

            {/* Tooltip */}
            {tooltip && (
                <div
                    className="absolute pointer-events-none bg-[#0a0a14]/95 border border-amber-500/20 rounded px-2.5 py-1.5 text-xs font-mono"
                    style={{
                        left: `${(tooltip.x / WIDTH) * 100}%`,
                        top: "10px",
                        transform: "translateX(-50%)",
                    }}
                >
                    <div className="text-gray-400 mb-1">{tooltip.date}</div>
                    {tooltip.entries.map((entry) => (
                        <div key={entry.district} className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                            <span className="text-gray-300">{entry.district}:</span>
                            <span className="text-gray-200">{entry.value.toLocaleString("cs-CZ")} CZK/m2</span>
                        </div>
                    ))}
                </div>
            )}

            {/* Legend */}
            {districts.length > 0 && (
                <div className="flex items-center gap-4 mt-2 justify-center">
                    {lines.map((line) => (
                        <div
                            key={line.district}
                            className="flex items-center gap-1.5 text-[10px] font-mono text-gray-400"
                        >
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: line.color }} />
                            {line.district}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
