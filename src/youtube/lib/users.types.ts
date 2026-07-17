import type { AskCitation, QaSource } from "@app/youtube/lib/qa.types";

export interface YtUser {
    id: number;
    email: string;
    credits: number;
    createdAt: string;
    /** Preferred output language for generated content (2-letter ISO). Null = unset, falls back to `"en"`. */
    outputLang: string | null;
    /** Preferred TTS voice id (Feature 12). Null = provider default. */
    ttsVoice: string | null;
}

export interface QaHistoryItem {
    id: number;
    videoId: string;
    question: string;
    answer: string;
    citations: AskCitation[];
    creditsSpent: number;
    createdAt: string;
    /** Source corpora the answer was produced from (transcript/comments). Absent on pre-sources rows. */
    sources?: QaSource[];
    /** Retrieval breadth: single video (default) or channel-wide. */
    scope?: "video" | "channel";
    /** Channel-scope only: the candidate videos the retrieval ran over. */
    candidateVideoIds?: string[];
    /** 2-letter ISO language the answer was generated in. Absent on pre-lang rows. */
    lang?: string;
}

export type CreditReason =
    | "register-grant"
    | "ask"
    | "qa:channel"
    | "summary:long"
    | "summary:timestamped"
    | "summary:short"
    | "transcript:translate"
    | "transcribe:ai"
    | "dev-topup"
    | `stripe:${string}`
    | `stripe-refund:${string}`
    | `refund:${string}`
    | `hold:${string}`
    | `hold-release:${string}`
    | `reuse:${string}`
    | `report:${string}`
    | `tts:${string}`;

/** A credit reservation taken before external (LLM/TTS) work starts. The
 * balance is already decremented while `status` is `"held"` — commit keeps
 * the money and finalizes the ledger reason, release refunds it. */
export interface CreditHold {
    id: number;
    userId: number;
    amount: number;
    /** The final ledger reason written on commit (e.g. `summary:long`). */
    reason: CreditReason;
    /** Free-form debug reference (typically the video id); never parsed. */
    context: string | null;
    status: "held" | "committed" | "released";
    createdAt: string;
    resolvedAt: string | null;
}

export const CREDIT_COSTS = {
    ask: 5,
    "qa:channel": 10,
    "summary:long": 10,
    "summary:timestamped": 10,
    "summary:short": 5,
    "transcript:translate": 5,
    "transcribe:ai": 10,
    "tts:summary": 5,
} as const;

/** Flat synthesis fee for a multi-video report (on top of per-member summary costs). */
export const REPORT_SYNTHESIS_COST = 20;

export const STARTING_CREDITS = 100;

/** Flat unlock price for an artifact somebody else already generated. */
export const REUSE_COST = 3;

/** Artifact kinds tracked in `artifact_access` (LLM-produced content only). */
export type ArtifactKind = "summary:long" | "summary:short" | "summary:timestamped" | "transcript:ai";

/** GET envelope returned instead of content when the artifact exists but the user has no access. */
export interface LockedArtifact {
    locked: true;
    price: number;
    preview: { tldr: string };
}

export class InsufficientCreditsError extends Error {
    constructor(
        public readonly balance: number,
        public readonly required: number
    ) {
        super(`Insufficient credits: have ${balance}, need ${required}`);
        this.name = "InsufficientCreditsError";
    }
}
