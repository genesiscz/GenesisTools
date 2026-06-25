export type CopilotAccountType = "individual" | "business" | "enterprise";

export interface CopilotTokenResponse {
    token: string;
    expires_at: number;
    refresh_in?: number;
}

export interface CopilotSessionCache {
    token: string;
    expiresAtMs: number;
    apiBaseUrl: string;
    refreshedAt: string;
}

export interface CopilotModelCapabilities {
    limits?: {
        max_context_window_tokens?: number;
        max_output_tokens?: number;
        max_prompt_tokens?: number;
    };
    supports?: {
        tool_calls?: boolean;
        parallel_tool_calls?: boolean;
    };
}

export interface CopilotModelRecord {
    id: string;
    name?: string;
    vendor?: string;
    version?: string;
    preview?: boolean;
    capabilities?: CopilotModelCapabilities;
    model_picker_enabled?: boolean;
    source: "live" | "catalog";
    description?: string;
}

export interface CopilotUsageSummary {
    plan?: string;
    quotaRemaining?: number;
    percentRemaining?: number;
    quotaResetDate?: string;
    raw?: Record<string, unknown>;
}
