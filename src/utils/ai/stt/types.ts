export const STT_PROVIDER_IDS = ["deepgram", "openai", "xai", "elevenlabs", "fixture"] as const;
export type SttProviderId = (typeof STT_PROVIDER_IDS)[number];

/** Older spellings accepted on the CLI and normalised to a provider id. */
export const STT_PROVIDER_ALIASES: Record<string, SttProviderId> = {
    "grok-live": "xai",
    grok: "xai",
    "gpt-realtime": "openai",
    gpt: "openai",
    scribe: "elevenlabs",
    mock: "fixture",
};

export const liveTranscriptKind = ["partial", "final", "speech_start", "speech_end", "error"] as const;
export type LiveTranscriptKind = (typeof liveTranscriptKind)[number];

export interface LiveTranscriptEvent {
    kind: LiveTranscriptKind;
    text: string;
    isFinal: boolean;
    confidence?: number;
    startedAtMs: number;
    endedAtMs?: number;
    /** Provider error detail; only on `kind: "error"`. */
    error?: string;
}

/** Audio the session accepts: signed 16-bit little-endian mono PCM at `sampleRateHz`. */
export const STT_DEFAULT_SAMPLE_RATE_HZ = 16000;

export interface OpenLiveSttOptions {
    provider: SttProviderId | string;
    /** `tools ai` account id or name; the provider's first enabled account when omitted. */
    account?: string;
    model?: string;
    /** ISO 639-1 codes in priority order, e.g. ["cs", "en"]. One code pins the language; several enable code switching. */
    languages?: string[];
    sampleRateHz?: number;
    signal?: AbortSignal;
    /** Fixture replay events (`provider: "fixture"` only). */
    events?: LiveTranscriptEvent[];
}

export interface LiveSttSession {
    provider: SttProviderId;
    accountId?: string;
    /** Feed one PCM frame. Frames sent before the socket is ready are queued. */
    write(pcm: Uint8Array): void;
    /** Tell the provider no more audio follows; pending finals still arrive on `events()`. */
    end(): void;
    events(): AsyncIterable<LiveTranscriptEvent>;
    close(): Promise<void>;
}

/** What a concrete cloud provider receives after credentials were resolved. */
export interface ProviderSessionOptions {
    apiKey: string;
    accountId: string;
    sampleRateHz: number;
    model?: string;
    /** ISO 639-1 codes in priority order; empty or absent means provider auto-detect. */
    languages?: string[];
    signal?: AbortSignal;
}

/** Parses `cs,en` / `cs, en` into a deduplicated list of lower-case codes. */
export function parseLanguages(raw: string | undefined): string[] | undefined {
    if (!raw) {
        return undefined;
    }

    const codes = [
        ...new Set(
            raw
                .split(",")
                .map((code) => code.trim().toLowerCase())
                .filter(Boolean)
        ),
    ];
    for (const code of codes) {
        if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(code)) {
            throw new Error(`Language code '${code}' is not an ISO 639 code like cs or en-US.`);
        }
    }

    return codes.length > 0 ? codes : undefined;
}
