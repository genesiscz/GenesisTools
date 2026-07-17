import type { Language } from "@app/youtube/lib/transcript.types";

export type YtRole = "admin" | "dev" | "user";

export interface PowerUserEntry {
    email: string;
    type: YtRole;
}

export const AI_TASKS = ["insights", "summary", "qa", "transcribe", "embed"] as const;
export type AiTask = (typeof AI_TASKS)[number];

export interface AiTaskMapping {
    provider: string;
    /** Optional — a provider-only entry mirrors the legacy `provider.<task>` strings. */
    model?: string;
    /** Tasks this entry serves; `"all"` marks the fallback used when a task has no explicit entry. */
    for: Array<AiTask | "all">;
}

export interface ReferralOffer {
    /** ISO datetime — offer window start. */
    from: string;
    /** ISO datetime — offer window end. */
    to: string;
    /** Diamonds granted to each side when the referral completes. */
    reward: number;
    description?: string;
}

export interface ReferralsConfig {
    enabled: boolean;
    offers: ReferralOffer[];
}

export interface YoutubeConfigShape {
    apiPort: number;
    apiBaseUrl: string;
    provider: {
        transcribe?: string;
        summarize?: string;
        qa?: string;
        embed?: string;
    };
    /** Email→role grants. Anyone not listed is a plain "user". */
    powerUsers: PowerUserEntry[];
    /** Task→model mapping; supersedes the legacy `provider.*` strings (kept as last-resort fallback). */
    ai: AiTaskMapping[];
    /** Referral program schema (logic lands in Phase 2). */
    referrals: ReferralsConfig;
    defaultQuality: "720p" | "1080p" | "best";
    concurrency: {
        download: number;
        localTranscribe: number;
        cloudTranscribe: number;
        summarize: number;
    };
    ttls: {
        audio: string;
        video: string;
        thumb: string;
        channelListing: string;
    };
    keepVideo: boolean;
    firstRunComplete: boolean;
    lastPruneAt: string | null;
    preferredLangs: Language[];
}
