import { FABLE_EXHAUSTED_PCT, FABLE_LOW_PCT } from "./account-picker";
import type { AccountUsage, UsageResponse } from "./api";
import { effectiveLeftPct, extractCompactLimits } from "./compact-limits";

/**
 * Whether an account can still serve Fable, read from the warm usage cache —
 * zero API calls. Used to warn before a launch that would burn the last of a
 * Fable weekly bucket, and to suggest an account that still has room.
 */

export interface FableStatus {
    /** True when Fable has real headroom (> FABLE_LOW_PCT), reset-aware. */
    available: boolean;
    /** True when the bucket is effectively spent (<= FABLE_EXHAUSTED_PCT). */
    exhausted: boolean;
    /** Effective % of the Fable weekly bucket still left. */
    leftPct: number;
    resetsAt: string | null;
}

/**
 * Undefined usage (never polled) is UNKNOWN and reported available: the launch
 * gate must never block on missing data. An account with no Fable-scoped limit
 * at all is likewise unconstrained.
 */
export function fableStatus(usage: UsageResponse | undefined, now: Date = new Date()): FableStatus {
    if (!usage) {
        return { available: true, exhausted: false, leftPct: 100, resetsAt: null };
    }

    const fable = extractCompactLimits(usage).fable;
    const leftPct = effectiveLeftPct(fable, now);

    return {
        available: leftPct > FABLE_LOW_PCT,
        exhausted: leftPct <= FABLE_EXHAUSTED_PCT,
        leftPct,
        resetsAt: fable?.resetsAt ?? null,
    };
}

/** Fable status for one account inside a cached poll result. */
export function fableStatusForAccount(
    accounts: AccountUsage[],
    accountName: string,
    now: Date = new Date()
): FableStatus {
    return fableStatus(accounts.find((a) => a.accountName === accountName)?.usage, now);
}

/** Reset-aware weekly headroom — a weekly-dead account 429s on every model. */
function hasWeeklyHeadroom(usage: UsageResponse, now: Date): boolean {
    return effectiveLeftPct(extractCompactLimits(usage).weekly, now) > 0;
}

/**
 * Accounts that can still run Fable AND have weekly headroom — the suggestion
 * list when the user declines a downgrade. Accounts with no usage data are
 * skipped: we can't vouch for them.
 */
export function fableCapableAccounts(accounts: AccountUsage[], now: Date = new Date()): string[] {
    return accounts
        .filter((a) => a.usage && fableStatus(a.usage, now).available && hasWeeklyHeadroom(a.usage, now))
        .map((a) => a.accountName);
}
