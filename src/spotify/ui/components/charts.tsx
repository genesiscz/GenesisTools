/**
 * Chart wrappers over recharts.
 *
 * Every chart in the dashboard goes through one of these so the grid, axes, tooltip and
 * series colours are decided once. Colours come from the `--chart-*` tokens in styles.css,
 * never from a hex at the call site.
 */

import { Card } from "@ui/components/card";
import { ChartBox } from "@ui/components/chart-box";
import { type ReactNode, useId } from "react";
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Line,
    LineChart,
    PolarAngleAxis,
    PolarGrid,
    PolarRadiusAxis,
    Radar,
    RadarChart,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

export const SERIES = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "var(--chart-6)",
];

const AXIS = {
    stroke: "var(--chart-axis)",
    fontSize: 11,
    fontFamily: "var(--font-mono, monospace)",
} as const;

/**
 * Recharts hands the tooltip a `ValueType` (number | string | array). Returning a plain
 * string keeps the formatter assignable without casting through recharts' internals.
 */
const tooltipValue = (format?: (v: number) => string) => (value: unknown) =>
    format ? format(Number(value)) : String(value);

const TOOLTIP_STYLE = {
    contentStyle: {
        background: "var(--color-popover)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        fontSize: 12,
    },
    labelStyle: { color: "var(--color-muted-foreground)", fontSize: 11 },
    itemStyle: { color: "var(--color-foreground)" },
} as const;

export function ChartCard({
    title,
    hint,
    children,
    actions,
}: {
    title?: string;
    hint?: string;
    children: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <Card variant="wow-static" className="p-4">
            {(title || actions) && (
                <div className="flex items-center justify-between gap-2 mb-3">
                    <div>
                        {title && <div className="text-sm font-medium text-foreground">{title}</div>}
                        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
                    </div>
                    {actions}
                </div>
            )}
            {children}
        </Card>
    );
}

export interface SeriesPoint {
    label: string;
    value: number;
}

/** Vertical bars over a categorical axis (years, months, buckets). */
export function BarSeries({
    data,
    height = 220,
    format,
    color = SERIES[0],
    highlightIndex,
}: {
    data: SeriesPoint[];
    height?: number;
    format?: (v: number) => string;
    color?: string;
    /** Draws this bar in the accent colour — used for "the peak". */
    highlightIndex?: number;
}) {
    return (
        <ChartBox height={height}>
            {({ width, height: h }) => (
                <BarChart width={width} height={h} data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                    <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                    <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={false} minTickGap={12} />
                    <YAxis {...AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={format} />
                    <Tooltip
                        {...TOOLTIP_STYLE}
                        formatter={tooltipValue(format)}
                        cursor={{ fill: "var(--chart-grid)" }}
                    />
                    <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                        {data.map((d, i) => (
                            <Cell key={d.label} fill={i === highlightIndex ? SERIES[3] : color} />
                        ))}
                    </Bar>
                </BarChart>
            )}
        </ChartBox>
    );
}

/** A filled trend line — the shape of listening over time. */
export function AreaSeries({
    data,
    height = 220,
    format,
    color = SERIES[0],
}: {
    data: SeriesPoint[];
    height?: number;
    format?: (v: number) => string;
    color?: string;
}) {
    // A fixed gradient id would make a second chart on the same page resolve `url(#…)` to the
    // first chart's gradient, so two AreaSeries with different colours would draw the same fill.
    const gradientId = `spotify-area-${useId()}`;

    return (
        <ChartBox height={height}>
            {({ width, height: h }) => (
                <AreaChart width={width} height={h} data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                    <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity={0.45} />
                            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                    <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis {...AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={format} />
                    <Tooltip {...TOOLTIP_STYLE} formatter={tooltipValue(format)} />
                    <Area
                        type="monotone"
                        dataKey="value"
                        stroke={color}
                        strokeWidth={2}
                        fill={`url(#${gradientId})`}
                        dot={false}
                    />
                </AreaChart>
            )}
        </ChartBox>
    );
}

export interface MultiLinePoint {
    label: string;
    [series: string]: string | number | null;
}

/** Several named series on one axis; `null` values leave a gap rather than a dive to zero. */
export function LineSeries({
    data,
    series,
    height = 240,
    format,
    domain,
}: {
    data: MultiLinePoint[];
    series: { key: string; label: string }[];
    height?: number;
    format?: (v: number) => string;
    domain?: [number, number];
}) {
    return (
        <ChartBox height={height}>
            {({ width, height: h }) => (
                <LineChart width={width} height={h} data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                    <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                    <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={false} minTickGap={20} />
                    <YAxis
                        {...AXIS}
                        tickLine={false}
                        axisLine={false}
                        width={48}
                        domain={domain}
                        tickFormatter={format}
                    />
                    <Tooltip {...TOOLTIP_STYLE} formatter={tooltipValue(format)} />
                    {series.map((s, i) => (
                        <Line
                            key={s.key}
                            type="monotone"
                            dataKey={s.key}
                            name={s.label}
                            stroke={SERIES[i % SERIES.length]}
                            strokeWidth={2}
                            dot={false}
                            connectNulls={false}
                        />
                    ))}
                </LineChart>
            )}
        </ChartBox>
    );
}

/** The eight-axis taste fingerprint. */
export function RadarSeries({ data, height = 320 }: { data: { axis: string; value: number }[]; height?: number }) {
    return (
        <ChartBox height={height}>
            {({ width, height: h }) => (
                <RadarChart width={width} height={h} data={data} outerRadius="72%">
                    <PolarGrid stroke="var(--chart-grid)" />
                    <PolarAngleAxis dataKey="axis" tick={{ fill: "var(--chart-axis)", fontSize: 11 }} />
                    <PolarRadiusAxis domain={[0, 1]} tick={false} axisLine={false} />
                    <Tooltip {...TOOLTIP_STYLE} formatter={tooltipValue((v) => `${Math.round(v * 100)}%`)} />
                    <Radar dataKey="value" stroke={SERIES[0]} fill={SERIES[0]} fillOpacity={0.28} />
                </RadarChart>
            )}
        </ChartBox>
    );
}

/** Two people's share of the same category, drawn back to back. */
export function PairedBars({
    data,
    aLabel,
    bLabel,
    height = 320,
    format,
}: {
    data: { label: string; a: number; b: number }[];
    aLabel: string;
    bLabel: string;
    height?: number;
    format?: (v: number) => string;
}) {
    return (
        <ChartBox height={height}>
            {({ width, height: h }) => (
                <BarChart
                    width={width}
                    height={h}
                    data={data}
                    layout="vertical"
                    margin={{ top: 4, right: 12, bottom: 4, left: 8 }}
                >
                    <CartesianGrid stroke="var(--chart-grid)" horizontal={false} />
                    <XAxis type="number" {...AXIS} tickLine={false} axisLine={false} tickFormatter={format} />
                    <YAxis
                        type="category"
                        dataKey="label"
                        {...AXIS}
                        tickLine={false}
                        axisLine={false}
                        width={116}
                        // Genre names run long ("electronic dance music"); recharts wraps them
                        // mid-word inside the axis gutter, which reads as a typo.
                        tickFormatter={(v: string) => (v.length > 17 ? `${v.slice(0, 16)}…` : v)}
                    />
                    <Tooltip {...TOOLTIP_STYLE} formatter={tooltipValue(format)} />
                    <Bar dataKey="a" name={aLabel} fill={SERIES[0]} radius={[0, 3, 3, 0]} />
                    <Bar dataKey="b" name={bLabel} fill={SERIES[1]} radius={[0, 3, 3, 0]} />
                </BarChart>
            )}
        </ChartBox>
    );
}
