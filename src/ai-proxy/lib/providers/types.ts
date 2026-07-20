import type { UsageSummary } from "@app/ai-proxy/lib/types";

export interface OpenAiModel {
    id: string;
    object: "model";
    created: number;
    owned_by: string;
    description?: string;
}

/** Upstream realtime WebSocket connect target resolved by a provider. */
export interface RealtimeConnectTarget {
    url: string;
    headers: Record<string, string>;
}

export interface ProxyProvider {
    id: string;
    readonly accountFingerprint: string;
    listModels(): Promise<OpenAiModel[]>;
    chatCompletions(req: Request, model: string, bodyText: string): Promise<Response>;
    responses(req: Request, model: string, bodyText: string): Promise<Response>;
    getUsage(): Promise<UsageSummary>;
    /** Providers with a realtime WS API return the upstream connect target; absent = unsupported. */
    realtimeConnect?(model: string): RealtimeConnectTarget;
    /** POST /realtime/client_secrets pass-through (ephemeral token mint); absent = unsupported. */
    realtimeClientSecrets?(req: Request, model: string, bodyText: string): Promise<Response>;
}
