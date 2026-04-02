import type { AnalysisFilters } from "@app/Internal/commands/reas/types";
import {
    buildErealityUrl,
    ErealityClient,
    erealityClient,
    extractTotalCount,
    parseErealityHtml,
} from "./ErealityClient";

export type { ErealityListing } from "./ErealityClient.types";

export { buildErealityUrl, ErealityClient, extractTotalCount, parseErealityHtml };

export async function fetchErealityRentals(filters: AnalysisFilters, refresh = false) {
    return erealityClient.fetchRentals(filters, refresh);
}
