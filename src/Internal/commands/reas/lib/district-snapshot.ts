import type { DistrictSnapshotRow } from "./store";

export type DistrictSnapshotResolution = "daily" | "monthly";

export interface SerializedDistrictSnapshot {
    id: number;
    district: string;
    constructionType: string;
    disposition: string | null;
    medianPricePerM2: number;
    comparablesCount: number;
    trendDirection: string | null;
    yoyChange: number | null;
    marketGrossYield: number | null;
    marketNetYield: number | null;
    snapshotDate: string;
    snapshotMonth: string;
}

export function serializeDistrictSnapshot(row: DistrictSnapshotRow): SerializedDistrictSnapshot {
    return {
        id: row.id,
        district: row.district,
        constructionType: row.construction_type,
        disposition: row.disposition,
        medianPricePerM2: row.median_price_per_m2,
        comparablesCount: row.comparables_count,
        trendDirection: row.trend_direction,
        yoyChange: row.yoy_change,
        marketGrossYield: row.market_gross_yield,
        marketNetYield: row.market_net_yield,
        snapshotDate: row.snapshot_date,
        snapshotMonth: row.snapshot_date.slice(0, 7),
    };
}

export function collapseDistrictSnapshots({
    rows,
    resolution,
}: {
    rows: DistrictSnapshotRow[];
    resolution: DistrictSnapshotResolution;
}): SerializedDistrictSnapshot[] {
    if (resolution === "daily") {
        return rows.map(serializeDistrictSnapshot);
    }

    const latestByMonth = new Map<string, DistrictSnapshotRow>();

    for (const row of rows) {
        const monthKey = row.snapshot_date.slice(0, 7);
        const existing = latestByMonth.get(monthKey);

        if (!existing) {
            latestByMonth.set(monthKey, row);
            continue;
        }

        if (row.snapshot_date > existing.snapshot_date) {
            latestByMonth.set(monthKey, row);
            continue;
        }

        if (row.snapshot_date === existing.snapshot_date && row.created_at > existing.created_at) {
            latestByMonth.set(monthKey, row);
        }
    }

    return [...latestByMonth.values()]
        .sort((left, right) => left.snapshot_date.localeCompare(right.snapshot_date))
        .map(serializeDistrictSnapshot);
}
