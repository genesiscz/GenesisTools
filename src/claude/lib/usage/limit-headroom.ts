import { fmtHours } from "./account-picker";
import type { AccountUsage } from "./api";
import { effectiveLeftPct, extractCompactLimits } from "./compact-limits";
import { weeklyStatusForAccount } from "./fable-guard";
import { planAllowsClaudeCode } from "./subscription";

/** One account that can still serve a turn, with how much of each window is USED (0-100). */
export interface HeadroomRow {
    account: string;
    /** Null when the account has no 5-hour window. */
    fiveHourUsedPct: number | null;
    weeklyUsedPct: number;
}

/** An account whose all-model weekly window is spent, with the accounts that still have room. */
export interface WeeklyLimitHit {
    account: string;
    resetsAt: string | null;
    headroom: HeadroomRow[];
}

/**
 * Accounts with room in the weekly window and in the 5-hour one (when they have one), least weekly used first.
 * Accounts with no reading, an error, the org-blocked flag or a plan that cannot run Claude Code are left out: a dead account can still hold a stale
 * reading that looks healthy.
 */
function accountsWithHeadroom(accounts: AccountUsage[], exclude: string, now: Date): HeadroomRow[] {
    const rows: HeadroomRow[] = [];

    for (const account of accounts) {
        if (account.accountName === exclude || account.error || account.orgBlocked || !account.usage) {
            continue;
        }

        // A free org keeps serving healthy-looking buckets while every call answers 403.
        if (!planAllowsClaudeCode(account)) {
            continue;
        }

        const limits = extractCompactLimits(account.usage);
        const weeklyLeft = effectiveLeftPct(limits.weekly, now);
        const fiveHourLeft = limits.session ? effectiveLeftPct(limits.session, now) : null;

        if (weeklyLeft <= 0 || fiveHourLeft === 0) {
            continue;
        }

        rows.push({
            account: account.accountName,
            fiveHourUsedPct: fiveHourLeft === null ? null : 100 - fiveHourLeft,
            weeklyUsedPct: 100 - weeklyLeft,
        });
    }

    return rows.sort((a, b) => a.weeklyUsedPct - b.weeklyUsedPct);
}

/** The hit when `accountName` has no weekly quota left, else null (an account never polled is never a hit). */
export function weeklyLimitHit(
    accounts: AccountUsage[],
    accountName: string,
    now: Date = new Date()
): WeeklyLimitHit | null {
    const weekly = weeklyStatusForAccount(accounts, accountName, now);

    if (weekly.available) {
        return null;
    }

    return {
        account: accountName,
        resetsAt: weekly.resetsAt,
        headroom: accountsWithHeadroom(accounts, accountName, now),
    };
}

function age(fetchedAt: number, now: Date): string {
    const minutes = Math.max(0, Math.round((now.getTime() - fetchedAt) / 60_000));

    return minutes < 60 ? `${minutes}m` : fmtHours(minutes / 60);
}

/**
 * The line added to Claude Code's own usage-limit text for an embedding app. Every figure is the share USED, so it
 * reads the same way as Claude Code's `/usage`.
 */
export function headroomNote(input: { headroom: HeadroomRow[]; fetchedAt: number; now?: Date }): string {
    const read = `read ${age(input.fetchedAt, input.now ?? new Date())} ago`;

    if (input.headroom.length === 0) {
        return `GenesisTools: no other account has headroom (${read}).`;
    }

    const rows = input.headroom.map((row) => {
        const fiveHour = row.fiveHourUsedPct === null ? "no 5h limit" : `5h ${Math.round(row.fiveHourUsedPct)}%`;
        return `${row.account} (${fiveHour}, week ${Math.round(row.weeklyUsedPct)}%)`;
    });

    return `GenesisTools: accounts with headroom (% used, ${read}): ${rows.join(", ")}.`;
}
