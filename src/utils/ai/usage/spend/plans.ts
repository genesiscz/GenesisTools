import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { riseSince } from "@genesiscz/utils/ai/usage/attribution/bar";
import { type AttributedEvent, sharesIn } from "@genesiscz/utils/ai/usage/attribution/spend-share";
import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import type { PlanPrice, UsageProviderSettings } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";

/**
 * Subscription value per billing cycle (design 2026-11-01, step U11, proposal 17): the list-price spend of the
 * sessions that ran on each subscription account this cycle, the share of weekly capacity it used, and what the plan
 * price bought. The price comes from the usage config (`providers.<plugin id>.plans.<plan>`), since no data source
 * has it. A Claude session reaches its account only through its pin; one without a pin is never guessed.
 */
export interface PlanValue {
    account: AccountKey;
    plan: string | null;
    /** ISO UTC; `guessed` when the account names no renewal, so the cycle is the last 30 days. */
    cycle: { from: string; to: string; guessed: boolean };
    renewsInDays: number | null;
    spendUsd: number;
    price: PlanPrice | null;
    /** spend / price, when the price is in USD. */
    paidBackX: number | null;
    /** The sum of the weekly window's rises this cycle, in points. */
    weeklyRisePct: number;
    /** Rises against the full capacity of the cycle's weeks so far (100 points a week), 0..1. */
    capacityUsed: number;
    usdPerWeeklyPoint: number | null;
    /** Attributed through a last pin: a session that changed account counts for the last one. */
    approximate: boolean;
}

const DAY_MS = 86_400_000;

/** The current cycle from the plan's next renewal day: one calendar month back from it. */
export function cycleOf(plan: AccountUsageSnapshot["plan"], now: Date): PlanValue["cycle"] {
    const renews = plan?.renewsAt
        ? Date.parse(plan.renewsAt.length === 10 ? `${plan.renewsAt}T00:00:00Z` : plan.renewsAt)
        : Number.NaN;

    if (!Number.isFinite(renews)) {
        return { from: new Date(now.getTime() - 30 * DAY_MS).toISOString(), to: now.toISOString(), guessed: true };
    }

    // One calendar month back, the day clamped to the shorter month: a cycle renewing March 31 began February 28
    // (or 29), never March 3 as `setUTCMonth` would roll it over.
    const start = new Date(renews);
    const day = start.getUTCDate();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 1);
    const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, daysInMonth));
    return { from: start.toISOString(), to: new Date(renews).toISOString(), guessed: false };
}

export function planValues(input: {
    snapshots: readonly AccountUsageSnapshot[];
    events: readonly AttributedEvent[];
    /** Raw weekly series of the accounts, at least one cycle long. */
    weekly: readonly SeriesEntry[];
    providers: Record<string, UsageProviderSettings>;
    now: Date;
}): PlanValue[] {
    return input.snapshots.map((snapshot) => {
        const account: AccountKey = {
            provider: snapshot.provider,
            accountId: snapshot.accountId,
            accountName: snapshot.accountName,
        };
        const cycle = cycleOf(snapshot.plan, input.now);
        const from = Date.parse(cycle.from);
        const until = Math.min(Date.parse(cycle.to), input.now.getTime());
        const shares = sharesIn({ events: input.events, account, from, to: until, reportCommand: () => "" });
        const spendUsd = shares.sessions.reduce((sum, session) => sum + session.costUsd, 0);
        const entry = input.weekly.find(
            (series) => series.provider === snapshot.provider && series.account === snapshot.accountName
        );
        const weeklyRisePct = entry ? riseSince(entry, from) : 0;
        const weeks = Math.max((until - from) / (7 * DAY_MS), 1 / 7);
        const plan = snapshot.plan?.name ?? null;
        const price = plan ? (input.providers[snapshot.provider]?.plans?.[plan] ?? null) : null;
        const renews = cycle.guessed ? null : Math.round((Date.parse(cycle.to) - input.now.getTime()) / DAY_MS);

        return {
            account,
            plan,
            cycle,
            renewsInDays: renews,
            spendUsd,
            price,
            paidBackX:
                price && price.currency === "USD" && price.priceMinor > 0 ? spendUsd / (price.priceMinor / 100) : null,
            weeklyRisePct,
            capacityUsed: weeklyRisePct / (100 * weeks),
            usdPerWeeklyPoint: weeklyRisePct > 0 && spendUsd > 0 ? spendUsd / weeklyRisePct : null,
            approximate: shares.sessions.some((session) => session.approximate),
        };
    });
}
