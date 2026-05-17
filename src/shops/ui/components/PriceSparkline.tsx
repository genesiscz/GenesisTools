import { Area, AreaChart } from "recharts";

export interface PriceSparklineProps {
    points: Array<{ d: string; c: number | null }>;
    width?: number;
    height?: number;
}

/**
 * Fixed-size sparkline. We deliberately do NOT use ResponsiveContainer here:
 * it measures its parent on the next animation frame, which means recharts
 * renders once with width=-1/height=-1 and emits a noisy console warning per
 * row (199 instances on a 128-row /watchlist page). Fixed dimensions render
 * synchronously and silently. The host cell is `w-32` (128px) — 100×28 fits
 * comfortably with no overflow.
 */
export function PriceSparkline({ points, width = 100, height = 28 }: PriceSparklineProps) {
    const data = points.filter((p) => p.c !== null).map((p) => ({ d: p.d, c: p.c as number }));
    if (data.length === 0) {
        return <span className="text-xs text-zinc-500 font-mono">no data</span>;
    }

    return (
        <AreaChart width={width} height={height} data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <Area
                type="monotone"
                dataKey="c"
                stroke="var(--color-neon-cyan)"
                fill="var(--color-neon-cyan)"
                fillOpacity={0.18}
                strokeWidth={1.25}
                dot={false}
                isAnimationActive={false}
            />
        </AreaChart>
    );
}
