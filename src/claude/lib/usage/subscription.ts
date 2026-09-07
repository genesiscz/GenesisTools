/**
 * Moved into the anthropic-sub plugin so `accounts.usage.poll` can reach the plan gate:
 * `src/utils/**` may not import `@app/*` (scripts/ci/check-package-boundaries.ts rule 1).
 * This door keeps the claude TUI and `tools claude config` on the old specifier.
 */
export {
    clearAnchorFailure,
    ensureSubscriptionAnchors,
    formatCoarseSpan,
    formatCzechDateTime,
    formatRelativeSpan,
    formatRenewsAt,
    formatRenewsAtFull,
    isAnchorDue,
    nextRenewalDate,
    planAllowsClaudeCode,
    refreshSubscriptionProfile,
    revalidateStalePlan,
    SUBSCRIPTION_RECHECK_MS,
} from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/subscription";
