import type { SessionsInConfig, ThinkingPresentationMode, UsageSummary } from "@app/ai-proxy/lib/types";
import type { PromptCacheKey } from "@genesiscz/utils/ai/prompt-cache-key";

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

export interface ProviderInspectionOptions {
    /** Diagnostic inspection must not rotate or persist credentials. */
    probe?: boolean;
}

/** What the proxy knows about a request beyond its body, for providers that need it. */
export interface ProviderRequestContext {
    /** The conversation's cache key (`@genesiscz/utils/ai/prompt-cache-key`), when one was resolved. */
    promptCacheKey?: PromptCacheKey;
    /** The subagents the session defined with their own model: an Agent call's `model` never overrides theirs. */
    sessionAgents?: readonly string[];
    /** The session record the request came from: an account failure names its switch command. */
    sessionId?: string;
    /** `sessionsIn` of the proxy config, read for this request, so an edit applies to the next request. */
    sessionsIn?: SessionsInConfig;
}

export interface ProxyProvider {
    id: string;
    readonly accountFingerprint: string;
    listModels(options?: ProviderInspectionOptions): Promise<OpenAiModel[]>;
    chatCompletions(
        req: Request,
        model: string,
        bodyText: string,
        options?: { thinkingMode?: ThinkingPresentationMode }
    ): Promise<Response>;
    responses(req: Request, model: string, bodyText: string): Promise<Response>;
    getUsage(options?: ProviderInspectionOptions): Promise<UsageSummary>;
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
    messages?(req: Request, model: string, bodyText: string, context?: ProviderRequestContext): Promise<Response>;
    /**
     * True when this provider routes its prompt cache by the OpenAI `prompt_cache_key` field, so the
     * `/v1/messages` translation carries the conversation's key into the OpenAI body (the Codex agent).
     * Absent = the field is never added: a strict upstream may answer 400 to a parameter it does not know.
     */
    acceptsPromptCacheKey?: boolean;
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
