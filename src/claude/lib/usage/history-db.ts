/**
 * The limits store moved to `@genesiscz/utils/ai/usage-poll/limits-db` and became
 * provider-neutral (spec 2026-09-04 section 6.2). This file stays as the compatibility
 * door for the claude-only callers (burn-pace, table-select, rename-account, the TUI
 * history view, the dev-dashboard aggregator) until each switches.
 */
export {
    DEFAULT_LIMITS_PROVIDER,
    resetsAtRoughlyEqual,
    type SeriesEntry,
    type SeriesPoint,
    type SeriesQuery,
    type SnapshotV2Extras,
    type SpendInput,
    type SpendSnapshot,
    UsageLimitsDb as UsageHistoryDb,
    type UsageSnapshot,
} from "@genesiscz/utils/ai/usage-poll/limits-db";
