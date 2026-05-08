import { ChartContainer } from "@app/utils/ui/graphs/ChartContainer";
import { Area, AreaChart } from "recharts";

export interface PriceSparklineProps {
    points: Array<{ d: string; c: number | null }>;
    width?: number;
    height?: number;
}

export function PriceSparkline({ points, height = 24 }: PriceSparklineProps) {
    const data = points.filter((p) => p.c !== null).map((p) => ({ d: p.d, c: p.c as number }));
    if (data.length === 0) {
        return <span className="text-xs text-zinc-500 font-mono">no data</span>;
    }

    return (
        <ChartContainer height={height} contentClassName="!p-0" className="bg-transparent shadow-none border-0">
            <AreaChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
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
        </ChartContainer>
    );
}
