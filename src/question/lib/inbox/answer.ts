import { logger } from "@genesiscz/utils/logger";
import { answerPreview, applyAnswers, checkAnswers, type DecisionAnswer } from "../decisions/answers";
import type { DeliverDeps, DeliveryResult } from "../decisions/deliver";
import { sendAnsweredDecisions } from "../decisions/send";
import { type HarvestedDecision, readDecisions } from "../decisions/store";
import { type AskDeps, answerAskForm, checkAskAnswer } from "../pending/ask";
import type { AskAnswer } from "../pending/types";

const { log } = logger.scoped("question-inbox");

export interface AnswerDecisionsInput {
    session: string;
    provider?: string;
    sourceHome?: string;
    deliveryKey?: string;
    cwd?: string;
    answers: DecisionAnswer[];
    /** Print the lines and the route; change nothing. */
    dryRun?: boolean;
}

export type AnswerDecisionInput = Omit<AnswerDecisionsInput, "answers"> & DecisionAnswer;

export interface AnswerDecisionDeps {
    file: string;
    events: string;
    /** The `❓ DECISION N` block of the session's last reply, for a decision the store does not have yet. */
    block: (session: string, number: number) => Promise<HarvestedDecision | null>;
    /** Provider-worker discovery, queue location and the tools runner; tests replace them. */
    deliver?: DeliverDeps;
}

export interface InboxAnswerResult {
    session: string | null;
    /** The line typed into the agent, or `form <id>` for a form. */
    text: string;
    channel: DeliveryResult["channel"] | "form" | "dry-run";
    delivered: boolean;
    /** A key or message may have arrived, but its outcome cannot be confirmed. */
    uncertain?: boolean;
    /** Where it went, else why it did not: the one line the hub and /qa show. */
    detail?: string;
    /** A short human place (`cmux · work · agent`, `codex worker w1`). */
    target?: string;
    /** One sentence saying why nothing was delivered. */
    error?: string;
    queueId?: string;
    queueTextHash?: string;
}

/**
 * Answers decisions of one session and delivers them as ONE message (the hub's Decisions pane
 * sends every drafted answer at once; the inbox sends one). Every answer is checked before
 * anything is written. A decision read from the transcript only is stored first through the
 * harvest path (same number, never renumbered), so every answer has a row to live on. The
 * delivery is `sendAnsweredDecisions`, the one the CLI `send` verb and the dashboard use: cmux
 * pane for Claude and Grok, steer for a tools codex worker, else queued (stored `answered`) for
 * the next prompt.
 */
export async function answerInboxDecisions(
    input: AnswerDecisionsInput,
    deps: AnswerDecisionDeps
): Promise<InboxAnswerResult> {
    if (input.answers.length === 0) {
        throw new Error("no answers to send");
    }

    const checked = await checkAnswers({
        session: input.session,
        answers: input.answers,
        rows: readDecisions(deps.file),
        block: deps.block,
    });

    if (input.dryRun) {
        return {
            session: input.session,
            text: answerPreview(input.session, checked),
            channel: "dry-run",
            delivered: false,
        };
    }

    const ids = await applyAnswers({
        file: deps.file,
        events: deps.events,
        session: input.session,
        provider: input.provider,
        cwd: input.cwd,
        checked,
    });
    const sent = await sendAnsweredDecisions({
        ids,
        session: input.session,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.sourceHome ? { sourceHome: input.sourceHome } : {}),
        ...(input.deliveryKey ? { deliveryKey: input.deliveryKey } : {}),
        files: deps,
        deps: deps.deliver ?? {},
    });
    log.info({ session: input.session, numbers: sent.numbers, channel: sent.channel }, "inbox answers sent");
    // `detail` is the one line the hub and /qa show: where it went, else why it did not.
    const detail = sent.target ?? sent.error;
    return {
        session: input.session,
        text: sent.text,
        channel: sent.channel ?? "queued",
        delivered: sent.delivered === true,
        ...(detail ? { detail } : {}),
        ...(sent.target ? { target: sent.target } : {}),
        ...(sent.error ? { error: sent.error } : {}),
        ...(sent.queueId ? { queueId: sent.queueId, queueTextHash: sent.queueTextHash } : {}),
    };
}

/** One decision: the inbox's click on an option letter. */
export function answerInboxDecision(input: AnswerDecisionInput, deps: AnswerDecisionDeps): Promise<InboxAnswerResult> {
    const { number, option, text, expectedRevision, ...rest } = input;
    return answerInboxDecisions({ ...rest, answers: [{ number, option, text, expectedRevision }] }, deps);
}

/**
 * Answers a pending question form. The agent that posted it is blocked in `question_wait` (or
 * polls), so storing the answer IS the delivery. A dry run makes the same checks and stores nothing.
 */
export async function answerInboxForm({
    formId,
    answers,
    dryRun = false,
    askDeps = {},
    answer = answerAskForm,
    check = checkAskAnswer,
}: {
    formId: string;
    answers: AskAnswer[];
    dryRun?: boolean;
    /** The pending-form store; tests pass a scratch database. */
    askDeps?: AskDeps;
    answer?: typeof answerAskForm;
    check?: typeof checkAskAnswer;
}): Promise<InboxAnswerResult> {
    if (dryRun) {
        const checked = check(formId, answers, askDeps);

        if (!checked.ok) {
            throw new Error(`question ${formId}: ${checked.error}`);
        }

        return {
            session: checked.form.sessionHint ?? null,
            text: `form ${formId}`,
            channel: "dry-run",
            delivered: false,
            detail: `would answer ${Object.keys(checked.answers).join(", ")}`,
        };
    }

    const outcome = await answer(formId, answers, askDeps);

    if (!outcome.ok) {
        throw new Error(`question ${formId}: ${outcome.error}`);
    }

    return {
        session: outcome.form.sessionHint ?? null,
        text: `form ${formId}`,
        channel: "form",
        delivered: true,
        detail: "the waiting agent receives it from question_wait",
    };
}
