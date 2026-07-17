export interface DiamondPack {
    id: "pack-small" | "pack-medium" | "pack-large";
    diamonds: number;
    usd: string;
}

export const DIAMOND_PACKS: DiamondPack[] = [
    { id: "pack-small", diamonds: 500, usd: "4.99" },
    { id: "pack-medium", diamonds: 2000, usd: "14.99" },
    { id: "pack-large", diamonds: 5000, usd: "29.99" },
];

export type SubscriptionStatus = "active" | "past_due" | "canceled";

export interface SubscriptionPlan {
    id: "sub-monthly";
    /** Diamonds granted each billing period (RESET, not additive). */
    allowance: number;
    usd: string;
}

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [{ id: "sub-monthly", allowance: 3000, usd: "9.99" }];

/** Balance below this flips `MeBillingContext.lowBalance` — clients nudge before costly actions. */
export const LOW_BALANCE_THRESHOLD = 15;

export interface MeBillingContext {
    subscription: {
        planId: string;
        status: SubscriptionStatus;
        periodEnd: string | null;
        allowance: number;
        allowanceRemaining: number;
        cancelAtPeriodEnd: boolean;
    } | null;
    /** Null when metering is disabled or the user is exempt (subscriber / payer). */
    freeQuota: { used: number; limit: number; month: string } | null;
    lowBalance: boolean;
}
