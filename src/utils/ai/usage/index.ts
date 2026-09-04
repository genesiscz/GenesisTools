/**
 * L7 — the shared usage layer.
 *
 * One append-only corpus every AI surface writes to and every dashboard reads
 * from, so "what did this month cost" stops being a question each tool answers
 * only about itself.
 *
 * It ADDS TO rather than replaces the stores that already exist. ai-proxy's
 * client ledger still books its own cost at write time (deterministic invoicing,
 * a CLAUDE.md carve-out) and claude's `UsageHistoryDb` is still the source of
 * truth for subscription bucket utilization; both merely emit here as well.
 */
export { dayFilePath, usageDir, utcDayOf } from "./paths";
export { emptyAggregate, queryUsage } from "./query";
export { recordUsage } from "./record";
export { isValidTimeZone, spendBucketKey, systemTimeZone } from "./series-keys";
export type {
    AccountRef,
    SpendGrain,
    SpendSeriesBucket,
    SpendSeriesPoint,
    UsageAggregate,
    UsageEvent,
    UsageEventInput,
    UsageQuery,
    UsageQueryResult,
} from "./types";
export { CLAUDE_ALL_ACCOUNT_ID, CLAUDE_ALL_ACCOUNT_NAME, UNBOUND_ACCOUNT_ID } from "./types";
