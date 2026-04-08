import { reasClient } from "@app/Internal/commands/reas/api/ReasClient";
import type { PointersAndClustersResponse, ReasBounds } from "@app/Internal/commands/reas/api/ReasClient.types";
import { resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import type { AnalysisFilters, DateRange } from "@app/Internal/commands/reas/types";

export interface MapClusterOptions {
    district: string;
    from: string;
    to: string;
    constructionType?: string;
    bounds?: ReasBounds;
}

export async function fetchMapClusters(options: MapClusterOptions): Promise<PointersAndClustersResponse["data"]> {
    const { district: districtName, from, to, constructionType = "brick", bounds } = options;

    const district = resolveDistrict(districtName);
    const dateRange: DateRange = {
        label: `${from} – ${to}`,
        from: new Date(from),
        to: new Date(to),
    };

    const filters: AnalysisFilters = {
        estateType: "flat",
        constructionType,
        periods: [dateRange],
        district,
        bounds,
    };

    return reasClient.fetchPointersAndClusters(filters, dateRange);
}
