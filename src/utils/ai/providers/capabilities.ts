/** The access kind and capabilities a provider plugin declares. Import-free, so another repo can vendor it. */
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
