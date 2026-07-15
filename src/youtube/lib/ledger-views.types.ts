// No real credit-ledger reason currently needs to stay whole despite having a
// colon — every colon-bearing reason seen so far (`summary:long` etc,
// `stripe:<id>`, `stripe-refund:<id>`) is meant to collapse to its prefix.
// Kept as an extension point per the plan's contract; add entries here if a
// future reason should NOT be split.
// "qa:channel" is an ACTION reason (channel-scope ask), not an id-suffixed
// one — splitting it would show a meaningless bare "qa" chip next to "ask".
const ACTION_REASON_ALLOWLIST: readonly string[] = ["qa:channel"];

/** Groups a ledger `reason` for display: allowlisted reasons pass through
 * whole, everything else is the segment before the first `:`. Pure — lives
 * in the `.types` file (not `ledger-views.ts`) so extension/browser code can
 * reuse it for client-side reason-chip filtering without pulling in the
 * server-only `YoutubeDatabase` dependency. */
export function ledgerReasonGroup(reason: string): string {
    if (ACTION_REASON_ALLOWLIST.includes(reason)) {
        return reason;
    }

    const separatorIndex = reason.indexOf(":");
    return separatorIndex === -1 ? reason : reason.slice(0, separatorIndex);
}

export interface UsageDay {
    date: string;
    spent: number;
    earned: number;
}

export interface UsageByReason {
    reason: string;
    spent: number;
    count: number;
}

export interface UsageSummary {
    days: UsageDay[];
    byReason: UsageByReason[];
    month: { spent: number; earned: number };
}

export interface LedgerRowData {
    id: number;
    delta: number;
    reason: string;
    balanceAfter: number;
    createdAt: string;
    context: string | null;
}

export interface LedgerPage {
    rows: LedgerRowData[];
    nextBefore: number | null;
}
