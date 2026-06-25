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
