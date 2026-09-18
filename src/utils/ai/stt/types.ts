export const STT_PROVIDER_IDS = ["deepgram", "xai", "openai", "fixture"] as const;
export type SttProviderId = (typeof STT_PROVIDER_IDS)[number];

export const liveTranscriptKind = ["partial", "final", "speech_start", "speech_end", "error"] as const;
export type LiveTranscriptKind = (typeof liveTranscriptKind)[number];

export interface LiveTranscriptEvent {
    kind: LiveTranscriptKind;
    text: string;
    isFinal: boolean;
    confidence?: number;
    startedAtMs: number;
    endedAtMs?: number;
}

export interface OpenLiveSttOptions {
    provider: SttProviderId;
    accountId?: string;
    model?: string;
    language?: string;
    signal?: AbortSignal;
    events?: LiveTranscriptEvent[];
}

export interface LiveSttSession {
    provider: SttProviderId;
    accountId?: string;
    events(): AsyncIterable<LiveTranscriptEvent>;
    close(): Promise<void>;
}
