import { ChartContainer, ChartTooltipContent, chartAxisProps, chartGridProps } from "@ui/graphs";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { buildDistrictPriceBarModel } from "./district-comparison-model";
import type { DistrictComparison } from "./types";

export function DistrictPriceBarChart({
    comparisons,
    targetDistrict,
    targetPricePerM2,
}: {
    comparisons: DistrictComparison[];
    targetDistrict?: string;
    targetPricePerM2?: number;
}) {
    const model = buildDistrictPriceBarModel({
        comparisons,
        targetDistrict,
        targetPricePerM2,
    });

    return (
        <ChartContainer
            title="District price ladder"
            description="Median CZK per m² across the selected districts with Prague average and target markers."
            height={320}
            className="border-white/5 bg-white/[0.02]"
        >
            <BarChart data={model.rows} layout="vertical" margin={{ top: 10, right: 28, left: 8, bottom: 12 }}>
                <CartesianGrid {...chartGridProps} horizontal={false} />
                <XAxis
                    {...chartAxisProps}
                    type="number"
                    tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
                />
                <YAxis {...chartAxisProps} type="category" dataKey="district" width={84} />
                <Tooltip
                    content={
                        <ChartTooltipContent
                            valueFormatter={(value) =>
                                `${Math.round(Number(value ?? 0)).toLocaleString("cs-CZ")} CZK/m²`
                            }
                        />
                    }
                />
                {model.pragueAverage !== null && (
                    <ReferenceLine
                        x={model.pragueAverage}
                        stroke="#22d3ee"
                        strokeDasharray="4 4"
                        label={{ value: "Avg", fill: "#67e8f9", position: "top", fontSize: 11 }}
                    />
                )}
                {model.targetPricePerM2 !== null && (
                    <ReferenceLine
                        x={model.targetPricePerM2}
                        stroke="#f59e0b"
                        strokeDasharray="4 4"
                        label={{ value: "Target", fill: "#fcd34d", position: "top", fontSize: 11 }}
                    />
                )}
                <Bar dataKey="medianPricePerM2" radius={[0, 8, 8, 0]}>
                    {model.rows.map((row) => (
                        <Cell
                            key={row.district}
                            fill={row.highlight ? "#f59e0b" : "#38bdf8"}
                            opacity={row.highlight ? 1 : 0.82}
                        />
                    ))}
                </Bar>
            </BarChart>
        </ChartContainer>
    );
}
