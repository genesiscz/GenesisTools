import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";

export interface DistrictComparisonSnapshot {
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

export interface DistrictComparisonSummary {
    medianPricePerM2: number;
    grossYield: number;
    netYield: number;
    daysOnMarket: number;
    targetPercentile: number;
    salesCount: number;
    rentalCount: number;
}

export interface DistrictComparison {
    district: string;
    exportData: DashboardExport;
    snapshots: DistrictComparisonSnapshot[];
    summary: DistrictComparisonSummary;
}
