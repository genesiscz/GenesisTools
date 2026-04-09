import { chartColors, chartSeriesPalette } from "@ui/graphs/colors";

export const chartAxisProps = {
    axisLine: false,
    tickLine: false,
    tick: {
        fill: chartColors.axis,
        fontSize: 12,
    },
};

export const chartGridProps = {
    stroke: chartColors.grid,
    strokeDasharray: "3 3",
    vertical: false,
};

export const chartTooltipStyle = {
    backgroundColor: chartColors.tooltipBg,
    border: `1px solid ${chartColors.tooltipBorder}`,
    borderRadius: 12,
    boxShadow: "0 18px 48px rgba(2, 6, 23, 0.38)",
};

export const chartLabelStyle = {
    color: chartColors.axis,
    fontSize: 12,
    fontFamily: "JetBrains Mono, monospace",
};

export function getChartColor(index: number): string {
    return chartSeriesPalette[index % chartSeriesPalette.length];
}
