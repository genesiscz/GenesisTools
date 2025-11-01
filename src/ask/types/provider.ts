import type { ProviderV1 } from "@ai-sdk/provider";
import type { ModelInfo, ProviderChoice } from "./chat";

export interface ProviderConfig {
    name: string;
    type: string;
    envKey: string;
    import?: string;
    baseURL?: string;
    description?: string;
    priority: number;
}

export interface DetectedProvider {
    name: string;
    type: string;
    key: string;
    provider: ProviderV1;
    models: ModelInfo[];
    config: ProviderConfig;
}

export interface PricingInfo {
    input: number; // Cost per 1K input tokens
    output: number; // Cost per 1K output tokens
    cachedInput?: number; // Cost per 1K cached input tokens
}
