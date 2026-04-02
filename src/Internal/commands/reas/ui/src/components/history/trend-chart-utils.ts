export interface TrendChartPoint {
    date: string;
    value: number;
    district: string;
}

export function normalizeTrendChartData(data: TrendChartPoint[]): TrendChartPoint[] {
    const pointsByDistrictDate = new Map<string, TrendChartPoint>();

    for (const point of data) {
        if (!point.date || !point.district || !Number.isFinite(point.value)) {
            continue;
        }

        pointsByDistrictDate.set(`${point.district}::${point.date}`, point);
    }

    return [...pointsByDistrictDate.values()];
}
