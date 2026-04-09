import type { DistrictComparison } from "./types";

const DISTRICT_TREND_COLORS = ["#f59e0b", "#06b6d4", "#10b981", "#a855f7", "#f43f5e", "#38bdf8"];

export const DISTRICT_TREND_TIMEFRAMES = [
    { label: "3M", days: 90 },
    { label: "6M", days: 180 },
    { label: "12M", days: 365 },
    { label: "24M", days: 730 },
] as const;

export interface DistrictTrendRow {
    date: string;
    [district: string]: number | string | undefined;
}

export interface DistrictTrendSeries {
    district: string;
    color: string;
    latestValue: number | null;
    latestDate: string | null;
    yoyChange: number | null;
}

function getCutoffDate({ latestDate, timeframeDays }: { latestDate: string; timeframeDays: number }) {
    const cutoff = new Date(`${latestDate}T00:00:00.000Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - timeframeDays + 1);
    return cutoff.toISOString().slice(0, 10);
}

export function buildDistrictTrendModel({
    comparisons,
    timeframeDays,
    visibleDistricts,
}: {
    comparisons: DistrictComparison[];
    timeframeDays: number;
    visibleDistricts: string[];
}) {
    const districts = comparisons
        .map((comparison) => comparison.district)
        .filter((district) => visibleDistricts.includes(district));
    const latestDate = comparisons
        .flatMap((comparison) => comparison.snapshots.map((snapshot) => snapshot.snapshotDate))
        .sort()
        .at(-1);

    if (!latestDate || districts.length === 0) {
        return {
            rows: [] as DistrictTrendRow[],
            series: [] as DistrictTrendSeries[],
            isEmpty: true,
        };
    }

    const cutoffDate = getCutoffDate({ latestDate, timeframeDays });
    const rowsByDate = new Map<string, DistrictTrendRow>();
    const series = districts.map((district, index) => {
        const comparison = comparisons.find((item) => item.district === district);
        const filteredSnapshots =
            comparison?.snapshots.filter(
                (snapshot) => snapshot.snapshotDate >= cutoffDate && snapshot.snapshotDate <= latestDate
            ) ?? [];
        const latestSnapshot = filteredSnapshots.at(-1) ?? null;

        for (const snapshot of filteredSnapshots) {
            const existingRow = rowsByDate.get(snapshot.snapshotDate) ?? {
                date: snapshot.snapshotDate,
            };

            existingRow[district] = snapshot.medianPricePerM2;
            rowsByDate.set(snapshot.snapshotDate, existingRow);
        }

        return {
            district,
            color: DISTRICT_TREND_COLORS[index % DISTRICT_TREND_COLORS.length],
            latestValue: latestSnapshot?.medianPricePerM2 ?? null,
            latestDate: latestSnapshot?.snapshotDate ?? null,
            yoyChange: latestSnapshot?.yoyChange ?? null,
        };
    });

    return {
        rows: [...rowsByDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
        series,
        isEmpty: rowsByDate.size === 0,
    };
}
