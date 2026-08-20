import type { ThinkingPresentationMode, UsageSummary } from "@app/ai-proxy/lib/types";

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
    chatCompletions(
        req: Request,
        model: string,
        bodyText: string,
        options?: { thinkingMode?: ThinkingPresentationMode }
    ): Promise<Response>;
    responses(req: Request, model: string, bodyText: string): Promise<Response>;
    getUsage(): Promise<UsageSummary>;
    /** Providers with a realtime WS API return the upstream connect target; absent = unsupported. */
    realtimeConnect?(model: string): RealtimeConnectTarget;
    /** POST /realtime/client_secrets pass-through (ephemeral token mint); absent = unsupported. */
    realtimeClientSecrets?(req: Request, model: string, bodyText: string): Promise<Response>;
    /**
     * Native Anthropic `/v1/messages`. Present only on upstreams that speak
     * Anthropic themselves, and when present the proxy forwards the client's
     * body with NO reshape — which is the only way `cache_control`, thinking
     * signatures and exact tool schemas survive the trip.
     */
    messages?(req: Request, model: string, bodyText: string): Promise<Response>;
    /**
     * True when the messages() upstream tolerates the OpenAI `reasoning_effort`
     * field, so an `:<effort>` suffix may be stamped onto the passthrough body
     * (Grok's CLI proxy ignores unknown parameters). Absent/false = never stamp:
     * api.anthropic.com rejects OpenAI-isms with a 400.
     */
    messagesAcceptsReasoningEffort?: boolean;
    /** OpenAI-compatible batch STT (/v1/audio/transcriptions); absent = unsupported. */
    audioTranscriptions?(req: Request, model: string, form: FormData): Promise<Response>;
}
