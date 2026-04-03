import type { DistrictSnapshotRow } from "./store";

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
    };
}
