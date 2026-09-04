export interface GrokAuthEntry {
    key: string;
    refresh_token?: string;
    expires_at?: string;
    oidc_client_id?: string;
    oidc_issuer?: string;
    email?: string;
    user_id?: string;
    team_id?: string;
    auth_mode?: string;
}

export interface GrokJwtClaims {
    tier?: number;
    scope?: string;
    referrer?: string;
    team_id?: string;
    sub?: string;
    exp?: number;
    iat?: number;
}

export interface GrokBillingConfig {
    monthlyLimit: { val: number };
    used: { val: number };
    onDemandCap: { val: number };
    billingPeriodStart: string;
    billingPeriodEnd: string;
}

/** One money figure from the CLI chat proxy, in minor units (cents for USD). */
export interface GrokMoneyValue {
    val: number;
}

/**
 * `GET /billing?format=credits`, the shape the Grok CLI's own `/usage` pane reads.
 *
 * A different question from `GrokBillingConfig`: the plain form reports on-demand and
 * prepaid MONEY for the calendar month, which is zero throughout on a pure subscription.
 * This form reports how much of the SUBSCRIPTION allowance the current period has spent,
 * as whole percent, plus a per-product split.
 */
export interface GrokCreditsConfig {
    /** `USAGE_PERIOD_TYPE_WEEKLY` on SuperGrok. The window the percentages belong to. */
    currentPeriod?: { type?: string; start?: string; end?: string };
    /** 0 to 100, the whole subscription allowance. Observed equal to the `productUsage` sum. */
    creditUsagePercent?: number;
    /** Per-product split, `GrokBuild` and `GrokChat` on this plan. */
    productUsage?: Array<{ product: string; usagePercent: number }>;
    onDemandCap?: GrokMoneyValue;
    onDemandUsed?: GrokMoneyValue;
    prepaidBalance?: GrokMoneyValue;
    isUnifiedBillingUser?: boolean;
    billingPeriodStart?: string;
    billingPeriodEnd?: string;
}

export type GrokModelVisibility = "high" | "medium" | "low";
export type GrokModelSpeed = "fast" | "medium" | "slow";
export type GrokModelThinking = "none" | "optional" | "reasoning" | "multi-agent";
export type GrokModelSource = "picker" | "probe" | "api-catalog" | "static";
export type GrokProbeStatus = "ok" | "fail" | "skipped";

export interface GrokModelRecord {
    id: string;
    context_window?: number;
    api_backend?: string;
    agent_type?: string;
    hidden?: boolean;
    source: GrokModelSource;
    visibility: GrokModelVisibility;
    speed: GrokModelSpeed;
    thinking: GrokModelThinking;
    probeStatus?: GrokProbeStatus;
    httpCode?: number;
    description?: string;
}

export interface GrokSettings {
    subscription_tier_display?: string;
    [key: string]: unknown;
}

export interface GrokProbeResult {
    httpCode: number;
    latencyMs: number;
    ok: boolean;
}

export interface GrokEndpointDoc {
    method: string;
    path: string;
    description?: string;
}
