/**
 * Dashboard preferences moved to `@genesiscz/utils/ai/usage-poll/dashboard-config` and
 * became per-provider maps under `Storage("ai-usage-dashboard")`, with a one-time copy of
 * the old claude-only store (spec 2026-09-04 section 7.4).
 */
export {
    DEFAULT_PROMINENT_LIMITS,
    hiddenFor,
    loadDashboardConfig,
    type PerProviderKeys,
    prominentFor,
    saveDashboardConfig,
    type UsageDashboardConfig,
} from "@genesiscz/utils/ai/usage-poll/dashboard-config";
