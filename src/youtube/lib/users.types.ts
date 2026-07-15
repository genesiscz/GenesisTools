import type { AskCitation } from "@app/youtube/lib/qa.types";

export interface YtUser {
    id: number;
    email: string;
    credits: number;
    createdAt: string;
}

export interface QaHistoryItem {
    id: number;
    videoId: string;
    question: string;
    answer: string;
    citations: AskCitation[];
    creditsSpent: number;
    createdAt: string;
}

export type CreditReason =
    | "register-grant"
    | "ask"
    | "summary:long"
    | "summary:timestamped"
    | "summary:short"
    | "dev-topup"
    | `stripe:${string}`
    | `stripe-refund:${string}`
    | `reuse:${string}`;

export const CREDIT_COSTS = {
    ask: 5,
    "summary:long": 10,
    "summary:timestamped": 10,
    "summary:short": 5,
} as const;

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
