import { ChartContainer, ChartTooltipContent, chartAxisProps, chartGridProps } from "@ui/graphs";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { buildDistrictYieldBarModel } from "./district-comparison-model";
import type { DistrictComparison } from "./types";

export function DistrictYieldBarChart({
    comparisons,
    targetDistrict,
}: {
    comparisons: DistrictComparison[];
    targetDistrict?: string;
}) {
    const model = buildDistrictYieldBarModel({ comparisons, targetDistrict });

    return (
        <ChartContainer
            title="District yield spread"
            description="Gross yield comparison with a portfolio benchmark line to show where rents outrun pricing."
            height={320}
            className="border-white/5 bg-white/[0.02]"
        >
            <BarChart data={model.rows} margin={{ top: 10, right: 24, left: 0, bottom: 12 }}>
                <CartesianGrid {...chartGridProps} />
                <XAxis {...chartAxisProps} dataKey="district" interval={0} angle={-18} textAnchor="end" height={56} />
                <YAxis {...chartAxisProps} tickFormatter={(value: number) => `${value.toFixed(1)}%`} width={48} />
                <Tooltip
                    content={<ChartTooltipContent valueFormatter={(value) => `${Number(value ?? 0).toFixed(2)}%`} />}
                />
                {model.benchmarkYield !== null && (
                    <ReferenceLine
                        y={model.benchmarkYield}
                        stroke="#10b981"
                        strokeDasharray="4 4"
                        label={{ value: "Benchmark", fill: "#6ee7b7", position: "right", fontSize: 11 }}
                    />
                )}
                <Bar dataKey="grossYield" radius={[8, 8, 0, 0]}>
                    {model.rows.map((row) => (
                        <Cell
                            key={row.district}
                            fill={row.highlight ? "#c084fc" : "#10b981"}
                            opacity={row.highlight ? 1 : 0.82}
                        />
                    ))}
                </Bar>
            </BarChart>
        </ChartContainer>
    );
}
