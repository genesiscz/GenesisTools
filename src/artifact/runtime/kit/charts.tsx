import type { CSSProperties, ReactNode } from "react";
import {
    Bar,
    CartesianGrid,
    Cell,
    ComposedChart,
    Legend,
    Line,
    Pie,
    PieChart,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import type { Tone } from "./primitives";

/**
 * Recharts-backed charts wired to the template tokens: series colors come from
 * the theme's tone variables, so swapping the template retints every chart.
 * One y scale per chart on purpose — for a second measure of a different
 * magnitude render a second (small) chart under the first, never a dual axis.
 */

export const TONE_COLOR: Record<Tone, string> = {
    ok: "var(--ok)",
    warn: "var(--warn)",
    err: "var(--err)",
    info: "var(--info)",
    neutral: "var(--dim)",
};

/** Fixed fallback assignment order for slices/series without an explicit color. */
const FALLBACK_ORDER: Tone[] = ["info", "warn", "ok", "err", "neutral"];

function seriesColor(s: { tone?: Tone; color?: string }, index: number): string {
    return s.color ?? TONE_COLOR[s.tone ?? FALLBACK_ORDER[Math.min(index, FALLBACK_ORDER.length - 1)]];
}

const TOOLTIP_STYLE: CSSProperties = {
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    color: "var(--text)",
    fontSize: 12,
};

const AXIS_TICK = { fill: "var(--dim)", fontSize: 11 };

/** Round up to a 1/2/5 × 10^n ceiling so the axis top lands on a readable number. */
function niceCeil(value: number): number {
    const mag = 10 ** Math.floor(Math.log10(Math.max(1, value)));

    for (const m of [1, 2, 5, 10]) {
        if (value <= m * mag) {
            return m * mag;
        }
    }

    return 10 * mag;
}

export interface ChartSeries {
    label: string;
    values: Array<number | null>;
    tone?: Tone;
    /** Raw CSS color; wins over `tone`. */
    color?: string;
    kind?: "bar" | "line";
    /** Bars sharing a stack name stack; `true` = the shared default stack. */
    stack?: boolean | string;
    /** Dashed line — use it whenever a gray/neutral series sits next to colored ones. */
    dashed?: boolean;
}

export interface ChartMarker {
    /** X label the marker sits on (e.g. a day). */
    at: string;
    label?: string;
    tone?: Tone;
}

export interface DayChartProps {
    /** X labels, one per data point (days, buckets, versions, …). */
    labels: string[];
    series: ChartSeries[];
    /** Log y scale; zero/null points are dropped so the scale never breaks. */
    log?: boolean;
    yLabel?: string;
    markers?: ChartMarker[];
    height?: number;
    /** Accessible name for the chart image (screen readers). Defaults to `yLabel` or "chart". */
    ariaLabel?: string;
}

/**
 * Internal per-series row key. `label` is display text only: two series may
 * carry the same label, and keying rows by it would make the second series
 * overwrite the first one's values in every row.
 */
export function seriesKey(index: number): string {
    return `s${index}`;
}

/** Only finite numbers reach the scale math; Infinity/NaN break the domain and the tick loop. */
function finiteOrNull(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Stack a bar belongs to; unstacked bars and lines get null. */
function stackIdOf(s: ChartSeries): string | null {
    if (s.kind === "line" || !s.stack) {
        return null;
    }

    return s.stack === true ? "stack" : s.stack;
}

/** One row per label, keyed by `seriesKey(i)`; non-finite and log-invalid points become null. */
export function chartRows(
    labels: string[],
    series: ChartSeries[],
    log: boolean
): Array<Record<string, string | number | null>> {
    return labels.map((label, i) => {
        const row: Record<string, string | number | null> = { x: label };

        for (const [index, s] of series.entries()) {
            const v = finiteOrNull(s.values[i]);
            row[seriesKey(index)] = log && (v === null || v <= 0) ? null : v;
        }

        return row;
    });
}

/**
 * Y-axis maximum: the tallest single point, where each NAMED stack totals on
 * its own. Summing every stacked bar regardless of `stackId` would double the
 * axis whenever a chart carries two independent stacks.
 */
export function chartStackMax(labels: string[], series: ChartSeries[]): number {
    const perPoint = labels.map((_, i) => {
        const totals = new Map<string, number>();
        let loose = 0;

        for (const s of series) {
            const v = finiteOrNull(s.values[i]);

            if (v === null) {
                continue;
            }

            const stack = stackIdOf(s);

            if (stack === null) {
                loose = Math.max(loose, v);

                continue;
            }

            totals.set(stack, (totals.get(stack) ?? 0) + Math.max(0, v));
        }

        return Math.max(loose, ...totals.values());
    });

    return Math.max(1, ...perPoint);
}

/**
 * 1-3-10 decade ticks. The LAST tick is always at or above `max`, because the
 * axis domain ends on it and `allowDataOverflow` would otherwise clip every
 * point above the top tick (max 3.1 used to produce a [1, 3] domain).
 */
export function logTicksFor(max: number): number[] {
    const ticks: number[] = [];

    for (let t = 1; ticks.length < 2 || (ticks[ticks.length - 1] ?? 1) < max; t *= 10) {
        ticks.push(t, t * 3);
    }

    while (ticks.length > 2 && (ticks[ticks.length - 2] ?? 0) >= max) {
        ticks.pop();
    }

    return ticks;
}

/** Bar/line chart over labeled points. Tooltip on hover; legend when 2+ series. */
export function DayChart({ labels, series, log = false, yLabel, markers, height = 300, ariaLabel }: DayChartProps) {
    const data = chartRows(labels, series, log);

    // Recharts' "auto" domain is unreliable here (under-shoots log scales, inflates
    // stacked bars) — compute the y max from the data and hand it explicit bounds.
    const stackMax = chartStackMax(labels, series);
    const niceMax = niceCeil(stackMax);
    const logTicks = log ? logTicksFor(stackMax) : [];

    return (
        <div
            className="rounded-card border border-line bg-panel/40 p-4"
            role="img"
            aria-label={ariaLabel ?? (yLabel ? `${yLabel} chart` : "chart")}
        >
            <ResponsiveContainer width="100%" height={height}>
                <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                    <CartesianGrid stroke="var(--border)" strokeOpacity={0.5} vertical={false} />
                    <XAxis dataKey="x" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
                    <YAxis
                        scale={log ? "log" : "auto"}
                        domain={log ? [1, logTicks[logTicks.length - 1] ?? 1] : [0, niceMax]}
                        ticks={log ? logTicks : undefined}
                        allowDataOverflow={log}
                        tick={AXIS_TICK}
                        tickLine={false}
                        axisLine={{ stroke: "var(--border)" }}
                        width={48}
                        label={
                            yLabel
                                ? {
                                      value: yLabel,
                                      angle: -90,
                                      position: "insideLeft",
                                      fill: "var(--dim)",
                                      fontSize: 11,
                                  }
                                : undefined
                        }
                    />
                    <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        labelStyle={{ color: "var(--text)", fontWeight: 600 }}
                        cursor={{ fill: "var(--border)", opacity: 0.3 }}
                    />
                    {series.length >= 2 ? (
                        <Legend
                            verticalAlign="top"
                            wrapperStyle={{ fontSize: 12, color: "var(--dim)", paddingBottom: 8 }}
                        />
                    ) : null}
                    {series.map((s, i) =>
                        s.kind === "line" ? (
                            <Line
                                key={seriesKey(i)}
                                dataKey={seriesKey(i)}
                                name={s.label}
                                stroke={seriesColor(s, i)}
                                strokeWidth={2}
                                strokeDasharray={s.dashed ? "5 4" : undefined}
                                dot={{ r: 2.5, fill: seriesColor(s, i), strokeWidth: 0 }}
                                connectNulls
                                isAnimationActive={false}
                            />
                        ) : (
                            <Bar
                                key={seriesKey(i)}
                                dataKey={seriesKey(i)}
                                name={s.label}
                                fill={seriesColor(s, i)}
                                fillOpacity={0.85}
                                stroke="var(--bg)"
                                strokeWidth={1}
                                stackId={stackIdOf(s) ?? undefined}
                                isAnimationActive={false}
                                radius={s.stack ? undefined : [3, 3, 0, 0]}
                                maxBarSize={28}
                            />
                        )
                    )}
                    {(markers ?? []).map((m, i) => (
                        <ReferenceLine
                            key={`${m.at}-${i}`}
                            x={m.at}
                            stroke={TONE_COLOR[m.tone ?? "err"]}
                            strokeDasharray="4 3"
                            label={
                                m.label
                                    ? {
                                          value: m.label,
                                          fill: TONE_COLOR[m.tone ?? "err"],
                                          fontSize: 10,
                                          position: "insideTopLeft",
                                      }
                                    : undefined
                            }
                        />
                    ))}
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    );
}

export interface DonutSlice {
    label: string;
    value: number;
    tone?: Tone;
    color?: string;
}

export interface DonutChartProps {
    slices: DonutSlice[];
    height?: number;
    /** Center label (e.g. the total). */
    center?: ReactNode;
    /** Accessible name for the chart image (screen readers). */
    ariaLabel?: string;
}

/** Donut breakdown with a side legend. Slice colors follow tones, in fixed order. */
export function DonutChart({ slices, height = 240, center, ariaLabel }: DonutChartProps) {
    return (
        <div
            className="relative rounded-card border border-line bg-panel/40 p-4"
            role="img"
            aria-label={ariaLabel ?? "breakdown chart"}
        >
            <ResponsiveContainer width="100%" height={height}>
                <PieChart>
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "var(--text)" }} />
                    <Legend
                        layout="vertical"
                        align="right"
                        verticalAlign="middle"
                        wrapperStyle={{ fontSize: 12, color: "var(--dim)", maxWidth: "55%" }}
                    />
                    <Pie
                        data={slices.map((s) => ({ name: s.label, value: s.value }))}
                        dataKey="value"
                        nameKey="name"
                        innerRadius="58%"
                        outerRadius="88%"
                        stroke="var(--bg)"
                        strokeWidth={2}
                        isAnimationActive={false}
                    >
                        {slices.map((s, i) => (
                            <Cell key={seriesKey(i)} fill={seriesColor(s, i)} />
                        ))}
                    </Pie>
                </PieChart>
            </ResponsiveContainer>
            {center ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center pr-[45%] text-sm text-dim">
                    {center}
                </div>
            ) : null}
        </div>
    );
}
