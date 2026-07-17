import type { MeBillingContext } from "@app/youtube/lib/billing.types";

export interface CreditBuckets {
    /** The single credit balance (`user.credits`). */
    total: number;
    /** Portion of the balance that came from the current period's allowance —
     *  claws back to the next period's allowance on renewal. */
    allowanceRemaining: number;
    /** Purchased/earned top-up remainder — survives the billing period reset. */
    topup: number;
    /** The full period allowance a plan grants (0 when not subscribed). */
    allowance: number;
}

/**
 * Splits the single credit balance into its resetting (subscription allowance)
 * and persistent (top-up) buckets for the "allowance vs top-up" visualization
 * (spec §4.2 — diamonds RESET each period, they are not additive). Pure and
 * browser-safe so both the extension panel and the web account page can render
 * the same split. Only an ACTIVE subscription contributes an allowance bucket.
 */
export function computeCreditBuckets(input: {
    credits: number;
    subscription: MeBillingContext["subscription"];
}): CreditBuckets {
    const { credits, subscription } = input;
    const active = subscription !== null && subscription.status === "active";
    const allowanceRemaining = active ? Math.max(0, Math.min(credits, subscription.allowanceRemaining)) : 0;

    return {
        total: credits,
        allowanceRemaining,
        topup: Math.max(0, credits - allowanceRemaining),
        allowance: active ? subscription.allowance : 0,
    };
}

/** Human copy for a subscription's renewal/cancellation state. Returns null
 *  when there's nothing dated to say (no period end). */
export function subscriptionRenewalCopy(subscription: NonNullable<MeBillingContext["subscription"]>): string | null {
    if (!subscription.periodEnd) {
        return null;
    }

    const date = new Date(subscription.periodEnd);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    // Format in UTC so the shown date matches the server's period-end date
    // regardless of the viewer's timezone (a US viewer must not see "Jul 30"
    // for a period ending 2026-07-31T00:00Z).
    const formatted = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

    if (subscription.cancelAtPeriodEnd) {
        return `Ends ${formatted} — won't renew`;
    }

    return `Renews ${formatted}`;
}
