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
    | "dev-topup";

export const CREDIT_COSTS = {
    ask: 5,
    "summary:long": 10,
    "summary:timestamped": 10,
    "summary:short": 5,
} as const;

export const STARTING_CREDITS = 100;

export class InsufficientCreditsError extends Error {
    constructor(
        public readonly balance: number,
        public readonly required: number
    ) {
        super(`Insufficient credits: have ${balance}, need ${required}`);
        this.name = "InsufficientCreditsError";
    }
}
