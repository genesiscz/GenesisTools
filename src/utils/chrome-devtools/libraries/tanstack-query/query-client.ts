import type { CdpLike } from "../../cdp-like.ts";
import { callInPage, type InPageCallOptions } from "../../evaluate.ts";
import { type QuerySummary, type QuerySummaryArgs, querySummary } from "./in-page/query-summary.ts";

export type { QueryRow, QuerySummary, QuerySummaryArgs } from "./in-page/query-summary.ts";

/** Reads every query of the QueryClient kept on `window[slot]` (expose it first with `findReactProps`). */
export function readQueryClient(
    cdp: CdpLike,
    args: QuerySummaryArgs,
    options: InPageCallOptions = {}
): Promise<QuerySummary> {
    return callInPage(cdp, querySummary, args, options);
}
