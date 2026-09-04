import type { LimitSeries } from "@app/dev-dashboard/contract/ai-accounts";
import { formatClock } from "@genesiscz/utils/format";
import { ChartBox } from "@ui/components/chart-box";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ChartLegend, type ChartLegendItem } from "./ChartLegend";

interface LimitsChartProps {
    title: string;
    series: LimitSeries[];
    colors: Record<string, string>;
    rangeMinutes: number;
    rangeEndMs: number;
    loading?: boolean;
    hint?: string;
    height?: number;
}

interface Row {
    t: number;
    [seriesKey: string]: number;
}

interface Sample {
    minute: number;
    key: string;
    percent: number;
}

/** Dash pattern per window kind so two windows of one account still read apart. */
const DASH_BY_KEY: Array<[RegExp, string | undefined]> = [
    [/^(five_hour|primary|session)$/, undefined],
    [/^(seven_day|secondary|weekly)$/, "6 3"],
    [/^seven_day_/, "2 2"],
    [/^monthly$/, "8 4"],
];

function dashFor(key: string): string | undefined {
    for (const [pattern, dash] of DASH_BY_KEY) {
        if (pattern.test(key)) {
            return dash;
        }
    }

    return "4 2";
}

export function seriesKey(s: LimitSeries): string {
    return `${s.accountId}:${s.key}`;
}

/**
 * Every window is sampled independently, so exact-timestamp joins leave most
 * rows with one value. Coalesce into minute buckets and carry the last known
 * value forward: utilization is a level that holds until the next sample.
 */
export function mergeLimitSeries(series: LimitSeries[]): Row[] {
    const samples: Sample[] = [];

    for (const s of series) {
        const key = seriesKey(s);

        for (const point of s.points) {
            const ms = new Date(point.t).getTime();

            if (Number.isNaN(ms)) {
                continue;
            }

            samples.push({ minute: Math.floor(ms / 60_000), key, percent: point.percent });
        }
    }

    samples.sort((a, b) => a.minute - b.minute);

    const rows: Row[] = [];
    const last: Record<string, number> = {};
    let currentMinute: number | null = null;
    let currentRow: Row | null = null;

    for (const sample of samples) {
        if (sample.minute !== currentMinute) {
            currentMinute = sample.minute;
            currentRow = { t: sample.minute * 60_000, ...last };
            rows.push(currentRow);
        }

        last[sample.key] = sample.percent;

        if (currentRow) {
            currentRow[sample.key] = sample.percent;
        }
    }

    return rows;
}

const TICK_COUNT = 6;

/** Limit windows over time, several accounts on one chart, coloured by account and dashed by window. */
export function LimitsChart({
    title,
    series,
    colors,
    rangeMinutes,
    rangeEndMs,
    loading,
    hint,
    height = 256,
}: LimitsChartProps) {
    const present = series.filter((s) => s.points.length > 0);

    if (loading) {
        return (
            <div className="dd-panel flex flex-col gap-3 p-4" aria-busy="true">
                <h3 className="dd-accent-text text-sm font-semibold">{title}</h3>
                <div className="dd-ai-skeleton w-full" style={{ height }} />
            </div>
        );
    }

    if (present.length === 0) {
        return (
            <div
                className="dd-panel flex flex-col items-center justify-center gap-2 p-4 text-center"
                style={{ minHeight: height }}
            >
                <h3 className="dd-accent-text text-sm font-semibold">{title}</h3>
                <p className="text-sm text-[var(--dd-text-muted)]">{hint ?? "No history yet."}</p>
            </div>
        );
    }

    const data = mergeLimitSeries(present);
    const domainStart = rangeEndMs - rangeMinutes * 60_000;
    const ticks = Array.from(
        { length: TICK_COUNT },
        (_, i) => domainStart + ((rangeEndMs - domainStart) * i) / (TICK_COUNT - 1)
    );
    const format = (ms: number) => formatClock(ms, rangeMinutes <= 1440 ? {} : { date: "numeric" });
    const legend: ChartLegendItem[] = present.map((s) => ({
        id: seriesKey(s),
        label: `${s.accountName} ${s.label}`,
        color: colors[s.accountId] ?? "var(--dd-accent-from)",
        dash: dashFor(s.key),
    }));

    return (
        <div className="dd-panel dd-ai-fade-up p-4">
            <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="dd-accent-text text-sm font-semibold">{title}</h3>
                <span className="dd-ai-mono text-xs text-[var(--dd-text-muted)]">{present.length} series</span>
            </div>
            <ChartBox height={height}>
                {(size) => (
                    <LineChart width={size.width} height={size.height} data={data}>
                        <CartesianGrid stroke="var(--dd-border)" strokeDasharray="3 3" />
                        <XAxis
                            dataKey="t"
                            type="number"
                            scale="time"
                            domain={[domainStart, rangeEndMs]}
                            ticks={ticks}
                            allowDataOverflow={false}
                            tickFormatter={format}
                            stroke="var(--dd-text-muted)"
                            fontSize={11}
                            minTickGap={28}
                        />
                        <YAxis domain={[0, 100]} stroke="var(--dd-text-muted)" fontSize={11} unit="%" width={38} />
                        <Tooltip
                            contentStyle={{
                                backgroundColor: "var(--dd-bg-panel)",
                                border: "1px solid var(--dd-border)",
                                borderRadius: 8,
                                color: "var(--dd-text-primary)",
                                fontSize: 12,
                            }}
                            labelFormatter={(ms) => format(ms as number)}
                            formatter={(value, name) => [`${value}%`, String(name)]}
                        />
                        {present.map((s) => (
                            <Line
                                key={seriesKey(s)}
                                type="monotone"
                                dataKey={seriesKey(s)}
                                name={`${s.accountName} ${s.label}`}
                                stroke={colors[s.accountId] ?? "var(--dd-accent-from)"}
                                strokeDasharray={dashFor(s.key)}
                                strokeWidth={2}
                                dot={false}
                                connectNulls
                                isAnimationActive={false}
                            />
                        ))}
                    </LineChart>
                )}
            </ChartBox>
            <ChartLegend items={legend} />
        </div>
    );
}
