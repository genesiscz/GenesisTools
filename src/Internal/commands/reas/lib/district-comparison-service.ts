import { fetchAndAnalyze } from "@app/Internal/commands/reas/lib/analysis-service";
import { buildDashboardExport, type DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { buildConfig, resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import {
    collapseDistrictSnapshots,
    type DistrictSnapshotResolution,
    type SerializedDistrictSnapshot,
} from "@app/Internal/commands/reas/lib/district-snapshot";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";

export interface DistrictComparisonOptions {
    districts: string[];
    constructionType?: string;
    disposition?: string;
    periods?: string;
    price?: number;
    area?: number;
    rent?: number;
    monthlyCosts?: number;
    providers?: string;
    refresh?: boolean;
    snapshotResolution?: DistrictSnapshotResolution;
}

export interface DistrictComparisonResult {
    district: string;
    exportData: DashboardExport;
    snapshots: SerializedDistrictSnapshot[];
    summary: {
        medianPricePerM2: number;
        grossYield: number;
        netYield: number;
        daysOnMarket: number;
        targetPercentile: number;
        salesCount: number;
        rentalCount: number;
    };
}

export async function compareDistricts(options: DistrictComparisonOptions): Promise<DistrictComparisonResult[]> {
    const {
        districts,
        constructionType = "brick",
        disposition,
        periods,
        price = 5000000,
        area = 80,
        rent,
        monthlyCosts,
        providers,
        refresh = false,
        snapshotResolution = "monthly",
    } = options;

    return Promise.all(
        districts.map(async (districtName) => {
            const district = resolveDistrict(districtName);
            const { filters, target } = buildConfig({
                district,
                constructionType,
                disposition,
                periodsStr: periods,
                price,
                area,
                rent,
                monthlyCosts,
                providers,
            });
            const analysis = await fetchAndAnalyze(filters, target, refresh);
            const exportData = buildDashboardExport(analysis);
            const snapshots = collapseDistrictSnapshots({
                rows: reasDatabase.getDistrictHistory(district.name, constructionType, 730, disposition),
                resolution: snapshotResolution,
            });

            return {
                district: district.name,
                exportData,
                snapshots,
                summary: {
                    medianPricePerM2: exportData.analysis.comparables.median,
                    grossYield: exportData.analysis.yield.grossYield,
                    netYield: exportData.analysis.yield.netYield,
                    daysOnMarket: exportData.analysis.timeOnMarket.median,
                    targetPercentile: exportData.analysis.comparables.targetPercentile,
                    salesCount: exportData.listings.sold.length,
                    rentalCount: exportData.listings.rentals.length,
                },
            };
        })
    );
}
