import type { EmbeddingModel, ImageModel, LanguageModel, SpeechModel, TranscriptionModel } from "ai";
import type { AccountEntry } from "../config/schema";

/**
 * A provider plugin is the extension point of the AI layer: adding a provider is
 * one folder plus one registry line, with no core edits.
 */

export type ProviderKind = "api-key" | "subscription" | "local" | "gateway";

export type Capability =
    | "chat"
    | "embed"
    | "transcribe"
    | "tts"
    | "translate"
    | "summarize"
    | "image"
    | "video"
    | "realtime"
    | "rerank";

export interface CredentialSpec {
    /** Fields this provider needs from `account.credentials`. */
    fields: ReadonlyArray<"apiKey" | "accessToken" | "refreshToken" | "authFile" | "dataDir">;
    /**
     * Environment variables this provider is willing to read, in order, WHEN the
     * account opts in via `useEnvApiKey`. Naming them here (rather than letting an
     * SDK read its own default) is what makes env resolution auditable.
     */
    envKeys: readonly string[];
    /** Fields without which the provider cannot work at all. */
    required?: ReadonlyArray<"apiKey" | "accessToken" | "authFile" | "dataDir">;
}

export interface BindContext {
    account: AccountEntry;
    fetch?: typeof fetch;
}

/**
 * A bound provider. Shaped as a superset of the ai-sdk provider interface so
 * cloud plugins are thin wrappers, while local and native providers implement
 * the same optional methods by hand.
 */
export interface ProviderBinding {
    readonly accountId: string;
    readonly providerId: string;
    /** True when calls spend metered money rather than a subscription. */
    readonly billed: boolean;
    readonly systemPromptPrefix?: string;
    language(modelId: string): LanguageModel;
    embedding?(modelId: string): EmbeddingModel;
    transcription?(modelId: string): TranscriptionModel;
    speech?(modelId: string): SpeechModel;
    image?(modelId: string): ImageModel;
    /** Local runtimes hold native handles; task facades call this in a finally. */
    dispose?(): void;
}

export interface HealthReport {
    ok: boolean;
    detail: string;
}

export interface ProviderPlugin {
    readonly id: string;
    readonly kind: ProviderKind;
    readonly capabilities: ReadonlySet<Capability>;
    readonly credential: CredentialSpec;
    bind(ctx: BindContext): Promise<ProviderBinding>;
    health?(ctx: BindContext): Promise<HealthReport>;
}
