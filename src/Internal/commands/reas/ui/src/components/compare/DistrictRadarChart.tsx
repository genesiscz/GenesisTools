import {
    ChartContainer,
    chartAxisProps,
    PolarAngleAxis,
    PolarGrid,
    PolarRadiusAxis,
    Radar,
    RadarChart,
} from "@ui/graphs";
import { buildDistrictRadarModel } from "./district-comparison-model";
import type { DistrictComparison } from "./types";

const RADAR_COLORS = ["#38bdf8", "#f59e0b", "#c084fc", "#10b981"];

export function DistrictRadarComparison({
    comparisons,
    selectedDistricts,
}: {
    comparisons: DistrictComparison[];
    selectedDistricts: string[];
}) {
    const model = buildDistrictRadarModel({ comparisons, selectedDistricts });

    if (model.rows.length === 0) {
        return null;
    }

    return (
        <ChartContainer
            title="Multi-factor radar"
            description="A fast read on pricing, yield, liquidity, discount, trend, and volume for up to four districts."
            height={360}
            className="border-white/5 bg-white/[0.02]"
        >
            <RadarChart data={model.rows} outerRadius="70%">
                <PolarGrid stroke="rgba(255,255,255,0.16)" />
                <PolarAngleAxis dataKey="metric" tick={{ ...chartAxisProps.tick, fontSize: 11 }} />
                <PolarRadiusAxis angle={90} domain={[0, 100]} tick={false} axisLine={false} />
                {model.series.map((series, index) => (
                    <Radar
                        key={series.district}
                        name={series.district}
                        dataKey={series.district}
                        stroke={RADAR_COLORS[index % RADAR_COLORS.length]}
                        fill={RADAR_COLORS[index % RADAR_COLORS.length]}
                        fillOpacity={0.14}
                        strokeWidth={2}
                    />
                ))}
            </RadarChart>
        </ChartContainer>
    );
}
