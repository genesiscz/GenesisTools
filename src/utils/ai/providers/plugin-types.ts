import type { EmbeddingModel, ImageModel, LanguageModel, SpeechModel, TranscriptionModel } from "ai";
import type { AccountEntry } from "../config/schema";
import type { AccountFeatures } from "./account-features";

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
    | "classify"
    | "sentiment"
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
    /**
     * This call is a DIAGNOSIS, not real use: read credentials, never rotate them.
     *
     * A subscription refresh token is single-use and its replacement only
     * survives if the config write lands, which is exactly what a worktree build
     * has guarded. A probe that refreshed would therefore spend the user's grant
     * with nowhere to persist the new one, silently bricking the account.
     *
     * Set by every diagnostic caller (`doctor`, `account test`) on the context
     * they already build, so a plugin honours it once and every future probe
     * inherits the guarantee. `health()` is always a probe and need not be told.
     */
    probe?: boolean;
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
    /**
     * Account lifecycle and quota features: login, logout, home discovery, usage
     * polling, transcript scope. Absent on api-key, local and gateway plugins.
     *
     * Deliberately a member rather than a new `Capability`: `Capability` is what
     * `TASK_CAPABILITY` switches on to pick a plugin for a call, so an
     * `"accounts"` member there would force every `pluginsByCapability` caller to
     * exclude it. A nested member has no blast radius.
     */
    readonly accounts?: AccountFeatures;
}
