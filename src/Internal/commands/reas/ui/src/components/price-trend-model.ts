import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";

export interface PriceTrendPoint {
    label: string;
    value: number;
    count: number;
    change: number | null | undefined;
}

export function buildPriceTrendModel(trends: DashboardExport["analysis"]["trends"]) {
    const points: PriceTrendPoint[] = trends.map((trend) => ({
        label: trend.period,
        value: trend.medianPricePerM2,
        count: trend.count,
        change: trend.qoqChange,
    }));

    if (points.length === 0) {
        return {
            isEmpty: true,
            points,
            yoyChange: 0,
            yoyLabel: "N/A",
        };
    }

    if (points.length < 2) {
        return {
            isEmpty: false,
            points,
            yoyChange: 0,
            yoyLabel: "N/A",
        };
    }

    const first = points[0].value;
    const last = points[points.length - 1].value;
    const yoyChange = first > 0 ? ((last - first) / first) * 100 : 0;

    return {
        isEmpty: false,
        points,
        yoyChange,
        yoyLabel: `${yoyChange >= 0 ? "+" : ""}${yoyChange.toFixed(1)}%`,
    };
}
