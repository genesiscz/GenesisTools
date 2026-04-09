import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";

interface HistoryPoint {
    label: string;
    value: number;
}

interface PropertyHistoryChartProps {
    title: string;
    valueSuffix?: string;
    color: string;
    points: HistoryPoint[];
}

const CHART_WIDTH = 640;
const CHART_HEIGHT = 220;
const CHART_PADDING = { top: 20, right: 20, bottom: 36, left: 56 };

function formatAxisValue(value: number): string {
    if (value >= 1000) {
        return `${(value / 1000).toFixed(0)}k`;
    }

    return value.toFixed(0);
}

export function PropertyHistoryChart({ title, valueSuffix = "", color, points }: PropertyHistoryChartProps) {
    if (points.length === 0) {
        return (
            <Card className="border-white/5 bg-white/[0.02]">
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-mono text-amber-400">{title}</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex h-[180px] items-center justify-center rounded-lg border border-white/5">
                        <p className="text-xs font-mono text-gray-500">Not enough history to chart yet</p>
                    </div>
                </CardContent>
            </Card>
        );
    }

    const values = points.map((point) => point.value);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const valueRange = maxValue - minValue || 1;
    const yMin = minValue - valueRange * 0.15;
    const yMax = maxValue + valueRange * 0.15;
    const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
    const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

    function getX(index: number): number {
        if (points.length === 1) {
            return CHART_PADDING.left + plotWidth / 2;
        }

        return CHART_PADDING.left + (index / (points.length - 1)) * plotWidth;
    }

    function getY(value: number): number {
        return CHART_PADDING.top + plotHeight - ((value - yMin) / (yMax - yMin)) * plotHeight;
    }

    const linePoints = points.map((point, index) => `${getX(index)},${getY(point.value)}`).join(" ");
    const areaPoints = [
        ...points.map((point, index) => `${getX(index)},${getY(point.value)}`),
        `${getX(points.length - 1)},${CHART_PADDING.top + plotHeight}`,
        `${getX(0)},${CHART_PADDING.top + plotHeight}`,
    ].join(" ");

    const yTicks = Array.from({ length: 4 }, (_, index) => yMin + ((yMax - yMin) / 3) * index);

    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-mono text-amber-400">{title}</CardTitle>
            </CardHeader>
            <CardContent>
                <svg
                    viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                    className="w-full"
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label={title}
                >
                    <defs>
                        <linearGradient
                            id={`history-gradient-${title.replace(/\s+/g, "-").toLowerCase()}`}
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                        >
                            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
                            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                        </linearGradient>
                    </defs>

                    {yTicks.map((tick) => (
                        <g key={tick}>
                            <line
                                x1={CHART_PADDING.left}
                                y1={getY(tick)}
                                x2={CHART_WIDTH - CHART_PADDING.right}
                                y2={getY(tick)}
                                stroke="rgba(255,255,255,0.05)"
                                strokeDasharray="4 4"
                            />
                            <text
                                x={CHART_PADDING.left - 8}
                                y={getY(tick) + 3}
                                textAnchor="end"
                                fill="rgba(255,255,255,0.3)"
                                fontSize="9"
                                fontFamily="monospace"
                            >
                                {formatAxisValue(tick)}
                            </text>
                        </g>
                    ))}

                    <polygon
                        points={areaPoints}
                        fill={`url(#history-gradient-${title.replace(/\s+/g, "-").toLowerCase()})`}
                    />
                    <polyline
                        points={linePoints}
                        fill="none"
                        stroke={color}
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />

                    {points.map((point, index) => (
                        <g key={`${point.label}-${index}`}>
                            <circle
                                cx={getX(index)}
                                cy={getY(point.value)}
                                r="3.5"
                                fill={color}
                                stroke="rgba(10,10,20,0.9)"
                                strokeWidth="2"
                            />
                            <text
                                x={getX(index)}
                                y={getY(point.value) - 10}
                                textAnchor="middle"
                                fill={color}
                                fontSize="8"
                                fontFamily="monospace"
                            >
                                {formatAxisValue(point.value)}
                                {valueSuffix}
                            </text>
                            <text
                                x={getX(index)}
                                y={CHART_HEIGHT - 8}
                                textAnchor="middle"
                                fill="rgba(255,255,255,0.4)"
                                fontSize="9"
                                fontFamily="monospace"
                            >
                                {point.label}
                            </text>
                        </g>
                    ))}
                </svg>
            </CardContent>
        </Card>
    );
}
