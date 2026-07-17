import type { SubscriptionStatus } from "@app/youtube/lib/billing.types";

/**
 * Pure allowance math for the subscription tier (single-balance design):
 * the ONE spendable balance stays `users.credits`; allowance vs topup are
 * DERIVED. Spends draw the allowance first, so:
 *   spentSince        = grantsSince − (balance − periodStartBalance)
 *   allowanceRemaining = clamp(allowanceGranted − spentSince, 0..balance)
 *   topupRemainder     = balance − allowanceRemaining   (survives resets)
 *   reset newBalance   = topupRemainder + newAllowance  (RESET, not additive)
 */
export interface PeriodStateInput {
    balance: number;
    periodStartBalance: number;
    /** SUM of positive grant-type ledger deltas since period start (db.getGrantsSince). */
    grantsSince: number;
    allowanceGranted: number;
}

export interface PeriodState {
    spentSince: number;
    allowanceRemaining: number;
    topupRemainder: number;
}

export function computePeriodState(input: PeriodStateInput): PeriodState {
    const netSince = input.balance - input.periodStartBalance;
    const spentSince = Math.max(0, input.grantsSince - netSince);
    const allowanceRemaining = Math.max(0, Math.min(input.balance, input.allowanceGranted - spentSince));
    const topupRemainder = Math.max(0, input.balance - allowanceRemaining);

    return { spentSince, allowanceRemaining, topupRemainder };
}

export interface AllowanceResetInput extends PeriodStateInput {
    newAllowance: number;
}

export interface AllowanceResetResult extends PeriodState {
    newBalance: number;
    /** Ledger delta to apply (can be 0 on an unspent renewal, negative on downgrade). */
    delta: number;
}

export function computeAllowanceReset(input: AllowanceResetInput): AllowanceResetResult {
    const state = computePeriodState(input);
    const newBalance = state.topupRemainder + input.newAllowance;
    const delta = newBalance - input.balance;

    return { ...state, newBalance, delta };
}

/** UTC month bucket key for quota_usage rows. */
export function monthKeyUtc(date: Date = new Date()): string {
    return date.toISOString().slice(0, 7);
}

/** Narrow a stored status string to the frozen union without a cast. */
export function toSubscriptionStatus(raw: string): SubscriptionStatus {
    if (raw === "canceled") {
        return "canceled";
    }

    if (raw === "past_due") {
        return "past_due";
    }

    return "active";
}
