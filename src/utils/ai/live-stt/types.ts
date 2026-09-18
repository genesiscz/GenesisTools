export const LIVE_STT_PROVIDERS = ["deepgram", "grok-live", "gpt-realtime", "mock"] as const;
export type LiveSttProviderId = (typeof LIVE_STT_PROVIDERS)[number];

export interface TranscriptEvent {
    type: "partial" | "final" | "error" | "ready";
    text: string;
    tMs: number;
    provider: LiveSttProviderId;
    error?: string;
}

export interface ConnectOptions {
    account?: string;
    language?: string;
    sampleRate: number;
    signal?: AbortSignal;
}

export interface LiveSttSession {
    write(pcm: Uint8Array): void;
    events(): AsyncIterable<TranscriptEvent>;
    close(): Promise<void>;
}

export interface LiveSttProvider {
    readonly id: LiveSttProviderId;
    connect(options: ConnectOptions): Promise<LiveSttSession>;
}

export interface WakeMatch {
    matched: string;
    remainder: string;
}
