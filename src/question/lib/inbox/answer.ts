import { logger } from "@genesiscz/utils/logger";
import type { DeliverDeps, DeliveryResult } from "../decisions/deliver";
import { decisionLine } from "../decisions/read";
import { sendAnsweredDecisions } from "../decisions/send";
import {
    type DecisionRecord,
    type HarvestedDecision,
    harvestDecisions,
    kindOf,
    readDecisions,
    updateDecisions,
} from "../decisions/store";
import { type AskDeps, answerAskForm, checkAskAnswer } from "../pending/ask";
import type { AskAnswer } from "../pending/types";

const { log } = logger.scoped("question-inbox");

/** One decision's answer: a letter, a text, or a letter with a note. */
export interface DecisionAnswer {
    number: number;
    /** One letter, a-z. Required unless `text` is given. */
    option?: string;
    /** A free-text answer, or a note after the letter. */
    text?: string;
}

export interface AnswerDecisionsInput {
    session: string;
    provider?: string;
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
    /** The delivery's `tools` runner and codex lookup; tests replace them. */
    deliver?: DeliverDeps;
}

export interface InboxAnswerResult {
    session: string | null;
    /** The line typed into the agent, or `form <id>` for a form. */
    text: string;
    channel: DeliveryResult["channel"] | "form" | "dry-run";
    delivered: boolean;
    /** Where it went, else why it did not: the one line the hub and /qa show. */
    detail?: string;
    /** A short human place (`cmux · work · agent`, `codex worker w1`). */
    target?: string;
    /** One sentence saying why nothing was delivered. */
    error?: string;
}

function findRow(rows: DecisionRecord[], session: string, number: number): DecisionRecord | undefined {
    return rows.find((row) => row.sessionId === session && row.number === number && kindOf(row) === "decision");
}

interface CheckedAnswer {
    number: number;
    option?: string;
    text?: string;
    row?: DecisionRecord;
    block?: HarvestedDecision;
}

/** Validates one answer against its stored row or its transcript block; throws a readable refusal. */
async function checkAnswer(
    session: string,
    answer: DecisionAnswer,
    rows: DecisionRecord[],
    deps: AnswerDecisionDeps
): Promise<CheckedAnswer> {
    const option = answer.option?.trim().toLowerCase() || undefined;
    const text = answer.text?.trim() || undefined;

    if (!option && !text) {
        throw new Error(`DECISION ${answer.number}: pass an option letter or an answer text`);
    }

    if (option && !/^[a-z]$/.test(option)) {
        throw new Error(`the option is one letter a-z, not "${answer.option}"`);
    }

    const row = findRow(rows, session, answer.number);
    const block = row ? null : await deps.block(session, answer.number);

    if (!row && !block) {
        throw new Error(`DECISION ${answer.number} is not waiting in session ${session}`);
    }

    const options = row?.options ?? block?.options ?? [];

    if (option && options.length > 0 && option.charCodeAt(0) - 97 >= options.length) {
        throw new Error(`DECISION ${answer.number} has options a-${String.fromCharCode(96 + options.length)}`);
    }

    if (row && row.state !== "open" && row.state !== "drafted") {
        throw new Error(`DECISION ${answer.number} is already ${row.state}`);
    }

    return { number: answer.number, option, text, ...(row ? { row } : {}), ...(block ? { block } : {}) };
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

    const rows = readDecisions(deps.file);
    const checked: CheckedAnswer[] = [];

    for (const answer of input.answers) {
        checked.push(await checkAnswer(input.session, answer, rows, deps));
    }

    if (input.dryRun) {
        const lines = checked.map((item) =>
            decisionLine({
                id: item.row?.id ?? `d_${item.number}_${input.session}`,
                sessionId: input.session,
                number: item.number,
                prompt: item.row?.prompt ?? item.block?.prompt ?? "",
                options: item.row?.options ?? item.block?.options ?? [],
                state: "answered",
                updatedTs: new Date().toISOString(),
                ...(item.option ? { option: item.option } : {}),
                ...(item.text ? { answer: item.text } : {}),
            })
        );
        return { session: input.session, text: lines.join("\n"), channel: "dry-run", delivered: false };
    }

    const found = checked.flatMap((item) => (item.block ? [item.block] : []));

    if (found.length > 0) {
        await harvestDecisions(deps.file, deps.events, {
            sessionId: input.session,
            provider: input.provider,
            cwd: input.cwd,
            found,
        });
    }

    const stored = readDecisions(deps.file);
    const updates = checked.map((item) => {
        const row = findRow(stored, input.session, item.number);

        if (!row) {
            throw new Error(`DECISION ${item.number} could not be stored for session ${input.session}`);
        }

        return {
            id: row.id,
            state: "answered" as const,
            ...(item.option ? { option: item.option } : {}),
            ...(item.text ? { answer: item.text } : {}),
        };
    });
    await updateDecisions(deps.file, deps.events, { updates });

    const sent = await sendAnsweredDecisions({
        session: input.session,
        ...(input.provider ? { provider: input.provider } : {}),
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
    };
}

/** One decision: the inbox's click on an option letter. */
export function answerInboxDecision(input: AnswerDecisionInput, deps: AnswerDecisionDeps): Promise<InboxAnswerResult> {
    const { number, option, text, ...rest } = input;
    return answerInboxDecisions({ ...rest, answers: [{ number, option, text }] }, deps);
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
