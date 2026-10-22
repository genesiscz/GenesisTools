import type { CodexFinishedTurn } from "@genesiscz/utils/codex/turn-cost";
import { logger } from "@genesiscz/utils/logger";
import type { ReviewEffort } from "@genesiscz/utils/worker/contract";
import { sumPartTokens } from "@genesiscz/utils/worker/cost";
import { checkReview, decideGate, type GateDecision, parseReviewReport, type ReviewGateChecks } from "./gate";
import { appendReviewRecord, type ReviewGateRecord, reviewLedgerBase } from "./ledger";
import type { CodexReviewConfig, CodexReviewSpent, ReviewVerdict } from "./types";

const log = logger.child({ component: "codex:review-gate" });

const UNREAD_RECORDED = 40;

export type ReviewGateAction =
    | { kind: "none" }
    | { kind: "steer"; text: string }
    | { kind: "escalate"; effort: ReviewEffort; name: string };

export interface ReviewTurnOutcome {
    /** The session's review record after this turn: spent, step and verdict updated. */
    review: CodexReviewConfig;
    action: ReviewGateAction;
    /** Absent when the gate did not run: a failed or interrupted turn, or a review whose verdict is final. */
    decision?: GateDecision;
    checks?: ReviewGateChecks;
}

export interface ReviewTurnInput {
    name: string;
    label?: string;
    review: CodexReviewConfig;
    finished: CodexFinishedTurn;
    /** The final agent message of the turn. */
    report: string;
    costUsd: number | null;
    ledgerPath?: string;
}

/** The name an escalated review runs under: the chain's first name and the new tier. */
export function escalatedReviewName(review: Pick<CodexReviewConfig, "chain">, effort: ReviewEffort): string {
    return `${review.chain}-${effort}`;
}

function addSpent(spent: CodexReviewSpent | undefined, finished: CodexFinishedTurn, costUsd: number | null) {
    const tokens = sumPartTokens(finished.parts);
    const before = spent ?? { turns: 0, durationMs: 0, toolCalls: 0, reasoningTokens: 0, outputTokens: 0, costUsd: 0 };

    return {
        turns: before.turns + 1,
        durationMs: before.durationMs + (finished.durationMs ?? 0),
        toolCalls: before.toolCalls + finished.toolCalls,
        reasoningTokens: before.reasoningTokens + tokens.reasoning,
        outputTokens: before.outputTokens + tokens.output,
        costUsd: before.costUsd === null || costUsd === null ? null : before.costUsd + costUsd,
    } satisfies CodexReviewSpent;
}

/** A review whose verdict is final takes follow-up turns without the gate: the lead asked something else. */
function gateIsOpen(review: CodexReviewConfig): boolean {
    return review.verdict === undefined || review.verdict === "steered";
}

/**
 * Books one finished review turn and decides the gate step. Writes one `turn` line, and one `gate` line when the
 * gate ran, to the review ledger. The caller performs the action: a steer into the same session, or an escalated
 * spawn under {@link escalatedReviewName}. Nothing here spawns or steers, so the whole decision is testable.
 */
export function recordReviewTurn(input: ReviewTurnInput): ReviewTurnOutcome {
    const { finished, report } = input;
    const tokens = sumPartTokens(finished.parts);
    const knownTokens = finished.parts.length > 0;
    const spent = addSpent(input.review.spent, finished, input.costUsd);
    const parsed = parseReviewReport(report);
    const base = reviewLedgerBase({ name: input.name, review: input.review, label: input.label, at: finished.endedAt });

    appendReviewRecord(
        base,
        {
            kind: "turn",
            turn: finished.turn,
            outcome: finished.outcome,
            model: finished.model,
            durationMs: finished.durationMs,
            toolCalls: finished.toolCalls,
            reasoningTokens: knownTokens ? tokens.reasoning : null,
            outputTokens: knownTokens ? tokens.output : null,
            costUsd: input.costUsd,
            coverage: parsed.coverage,
        },
        input.ledgerPath
    );

    const counted: CodexReviewConfig = { ...input.review, spent };

    if (finished.outcome !== "completed" || !gateIsOpen(input.review)) {
        return { review: counted, action: { kind: "none" } };
    }

    const checks = checkReview({
        report,
        manifest: input.review.manifest,
        effort: input.review.effort,
        reasoningTokens: knownTokens || spent.reasoningTokens > 0 ? spent.reasoningTokens : null,
    });
    const decision = decideGate(checks, input.review);
    const escalatedTo =
        decision.verdict === "escalated" && decision.nextEffort
            ? escalatedReviewName(input.review, decision.nextEffort)
            : undefined;
    const review: CodexReviewConfig = {
        ...counted,
        verdict: decision.verdict,
        reason: decision.reason,
        step:
            decision.verdict === "steered" || decision.verdict === "escalated"
                ? input.review.step + 1
                : input.review.step,
        ...(escalatedTo ? { escalatedTo } : {}),
    };

    writeGateRecord({ input, review, checks, decision, escalatedTo });
    log.debug(
        { name: input.name, verdict: decision.verdict, reason: decision.reason, step: input.review.step },
        "review gate decided"
    );

    if (decision.verdict === "steered" && decision.steer) {
        return { review, action: { kind: "steer", text: decision.steer }, decision, checks };
    }

    if (decision.verdict === "escalated" && decision.nextEffort && escalatedTo) {
        return {
            review,
            action: { kind: "escalate", effort: decision.nextEffort, name: escalatedTo },
            decision,
            checks,
        };
    }

    return { review, action: { kind: "none" }, decision, checks };
}

function writeGateRecord(options: {
    input: Pick<ReviewTurnInput, "name" | "label" | "ledgerPath">;
    review: CodexReviewConfig;
    checks: ReviewGateChecks | null;
    decision: Pick<GateDecision, "verdict" | "reason">;
    escalatedTo?: string;
}): ReviewGateRecord | null {
    const { input, review, checks, decision } = options;
    const record = appendReviewRecord(
        reviewLedgerBase({ name: input.name, review, label: input.label }),
        {
            kind: "gate",
            step: review.step,
            verdict: decision.verdict,
            reason: decision.reason,
            coverage: {
                reviewed: checks?.coverage.reviewed ?? null,
                total: checks?.coverage.total ?? review.manifest.files.length,
            },
            reasoningPer100Lines: checks?.reasoning.per100Lines ?? null,
            floor: checks?.reasoning.floor ?? 0,
            findings: checks?.shape.findings ?? 0,
            malformedFindings: checks?.shape.malformed.length ?? 0,
            unread: checks?.coverage.unread.slice(0, UNREAD_RECORDED) ?? [],
            ...(options.escalatedTo ? { escalatedTo: options.escalatedTo } : {}),
            spent: review.spent ?? {
                turns: 0,
                durationMs: 0,
                toolCalls: 0,
                reasoningTokens: 0,
                outputTokens: 0,
                costUsd: null,
            },
        },
        input.ledgerPath
    );

    return record?.kind === "gate" ? record : null;
}

/**
 * The gate wanted a step the runtime could not take (the steer was refused, the escalated spawn failed): the review
 * ends `shallow` with that reason, in the session record and as one more gate line.
 */
export function markReviewShallow(input: {
    name: string;
    label?: string;
    review: CodexReviewConfig;
    reason: string;
    ledgerPath?: string;
}): CodexReviewConfig {
    const verdict: ReviewVerdict = "shallow";
    const review: CodexReviewConfig = { ...input.review, verdict, reason: input.reason, escalatedTo: undefined };
    writeGateRecord({ input, review, checks: null, decision: { verdict, reason: input.reason } });
    log.warn({ name: input.name, reason: input.reason }, "review marked shallow");
    return review;
}
