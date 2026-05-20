import type { BucketSeries } from "@app/dev-dashboard/lib/claude-usage/types";
import { formatClock } from "@app/utils/format";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface UsageChartProps {
    title: string;
    series: BucketSeries[];
    rangeMinutes: number;
    /** End of the shared time window (epoch ms). Same value across all charts so their axes align. */
    rangeEndMs: number;
    loading?: boolean;
    hint?: string;
}

const BUCKET_META: Record<string, { label: string; color: string }> = {
    five_hour: { label: "5-hour", color: "#34d399" },
    seven_day: { label: "7-day", color: "#60a5fa" },
    seven_day_sonnet: { label: "7-day Sonnet", color: "#fbbf24" },
    seven_day_opus: { label: "7-day Opus", color: "#f472b6" },
    seven_day_oauth_apps: { label: "7-day OAuth", color: "#a78bfa" },
};

function bucketMeta(bucket: string): { label: string; color: string } {
    return BUCKET_META[bucket] ?? { label: bucket, color: "#94a3b8" };
}

function formatTick(timestamp: number | string, rangeMinutes: number): string {
    return formatClock(timestamp, rangeMinutes <= 1440 ? {} : { date: "numeric" });
}

interface Row {
    /** Epoch ms (minute-bucketed) — a real time value so the X axis is time-scaled, not categorical. */
    t: number;
    [bucket: string]: number;
}

interface Sample {
    minute: number;
    ts: string;
    bucket: string;
    utilization: number;
}

/**
 * Each bucket is polled independently, so exact-timestamp joins leave most
 * rows with only one series' value and the hover card shows just that line.
 * Coalesce samples into minute buckets, then carry the last-known value of
 * every series forward — utilization is a level that holds until the next
 * sample, so at any x the nearest value of all three lines is well-defined
 * and the tooltip always shows all of them.
 */
function mergeSeries(series: BucketSeries[]): Row[] {
    const samples: Sample[] = [];

    for (const s of series) {
        for (const snap of s.snapshots) {
            const ms = new Date(snap.timestamp).getTime();
            if (Number.isNaN(ms)) {
                continue;
            }

            samples.push({
                minute: Math.floor(ms / 60_000),
                ts: snap.timestamp,
                bucket: s.bucket,
                utilization: snap.utilization,
            });
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

        last[sample.bucket] = sample.utilization;
        if (currentRow) {
            currentRow[sample.bucket] = sample.utilization;
        }
    }

    return rows;
}

export function UsageChart({ title, series, rangeMinutes, rangeEndMs, loading, hint }: UsageChartProps) {
    const present = series.filter((s) => s.snapshots.length > 0);

    if (loading) {
        return (
            <div className="dd-panel relative flex h-72 items-center justify-center p-4 text-[var(--dd-text-muted)]">
                <h3 className="dd-accent-text absolute left-4 top-3 text-sm font-semibold">{title}</h3>
                Loading…
            </div>
        );
    }

    if (present.length === 0) {
        return (
            <div className="dd-panel flex h-72 flex-col items-center justify-center p-4 text-center text-[var(--dd-text-muted)]">
                <h3 className="dd-accent-text mb-2 text-sm font-semibold">{title}</h3>
                {hint ?? "No history yet."}
            </div>
        );
    }

    const data = mergeSeries(present);
    const domainStart = rangeEndMs - rangeMinutes * 60_000;

    // Fixed, evenly-spaced ticks across the shared domain so every chart shows
    // the SAME labels at the SAME x positions — without this, recharts places
    // ticks on each series' own sample points and stacked charts drift apart.
    const TICK_COUNT = 6;
    const ticks = Array.from(
        { length: TICK_COUNT },
        (_, i) => domainStart + ((rangeEndMs - domainStart) * i) / (TICK_COUNT - 1)
    );

    return (
        <div className="dd-panel p-4">
            <h3 className="dd-accent-text mb-3 text-sm font-semibold">{title}</h3>
            <ResponsiveContainer width="100%" height={256}>
                <LineChart data={data}>
                    <CartesianGrid stroke="var(--dd-border)" strokeDasharray="3 3" />
                    <XAxis
                        dataKey="t"
                        type="number"
                        scale="time"
                        domain={[domainStart, rangeEndMs]}
                        ticks={ticks}
                        allowDataOverflow={false}
                        tickFormatter={(ms: number) => formatTick(ms, rangeMinutes)}
                        stroke="var(--dd-text-muted)"
                        fontSize={11}
                        minTickGap={28}
                    />
                    <YAxis domain={[0, 100]} stroke="var(--dd-text-muted)" fontSize={11} unit="%" width={38} />
                    <Tooltip
                        contentStyle={{
                            backgroundColor: "var(--dd-bg-panel)",
                            border: "1px solid var(--dd-border)",
                            color: "var(--dd-text-primary)",
                        }}
                        labelFormatter={(ms) => formatTick(ms as number, rangeMinutes)}
                        formatter={(value, name) => [`${value}%`, name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {present.map((s) => {
                        const meta = bucketMeta(s.bucket);

                        return (
                            <Line
                                key={s.bucket}
                                type="monotone"
                                dataKey={s.bucket}
                                name={meta.label}
                                stroke={meta.color}
                                strokeWidth={2}
                                dot={false}
                                connectNulls
                                isAnimationActive={false}
                            />
                        );
                    })}
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
