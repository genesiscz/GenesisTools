import type { ReviewEffort, ReviewManifest } from "@genesiscz/utils/worker/contract";

/**
 * What the depth gate decided about one review turn. `imported` is never decided by the gate: it marks a review
 * backfilled from a session that ran before the ledger and whose final message has no coverage line.
 */
export const REVIEW_VERDICTS = ["pass", "steered", "escalated", "shallow", "imported"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Where the base ref came from; printed at spawn, because a derived base is a guess the caller must see. */
export type ReviewBaseSource = "flag" | "pr" | "upstream";

/** What the review turns of one session spent, summed; the gate's reasoning floor reads it. */
export interface CodexReviewSpent {
    turns: number;
    durationMs: number;
    toolCalls: number;
    reasoningTokens: number;
    outputTokens: number;
    /** API-equivalent dollars; null while any turn was unpriced. */
    costUsd: number | null;
}

/** The `--mode review` part of a codex session record. */
export interface CodexReviewConfig {
    base: string;
    baseSource: ReviewBaseSource;
    /** One human sentence on how the base was chosen. */
    baseDetail: string;
    branch?: string;
    pr?: number;
    manifest: ReviewManifest;
    effort: ReviewEffort;
    effortSource: "flag" | "diff-size";
    allowShallow: boolean;
    /** Automatic gate steps already taken in this review chain: 0 fresh, 1 after the steer, 2 in the escalated session. */
    step: number;
    /** The first session of the chain; an escalated session keeps its parent's chain. */
    chain: string;
    parent?: string;
    /** The first prompt of the review, kept so an escalation can rerun it. */
    prompt?: string;
    verdict?: ReviewVerdict;
    reason?: string;
    escalatedTo?: string;
    spent?: CodexReviewSpent;
}
