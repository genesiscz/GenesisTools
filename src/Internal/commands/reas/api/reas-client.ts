import type { AnalysisFilters, DateRange } from "@app/Internal/commands/reas/types";
import { buildReasQueryParams, ReasClient, reasClient } from "./ReasClient";

export type { CountResponse, ListingsResponse } from "./ReasClient.types";
export { buildReasQueryParams, ReasClient };

export async function fetchSoldCount(filters: AnalysisFilters, dateRange: DateRange): Promise<number> {
    return reasClient.fetchSoldCount(filters, dateRange);
}

export async function fetchSoldListings(filters: AnalysisFilters, dateRange: DateRange, refresh = false) {
    return reasClient.fetchSoldListings(filters, dateRange, refresh);
}
