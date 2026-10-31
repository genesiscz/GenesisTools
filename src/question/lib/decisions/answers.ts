import { canonicalAgent } from "@app/handoff/targeting";
import { DeliveryUnknownError, NotDeliveredError } from "./delivery-errors";
import { decisionLines, deliverDecisions, optionLetters } from "./read";
import {
    awaitsAnswer,
    awaitsDelivery,
    type DecisionRecord,
    type DecisionState,
    type HarvestedDecision,
    kindOf,
    moveDecisions,
    readDecisions,
    restoreUndelivered,
    staleRevisionError,
} from "./store";

/**
 * The rules every door applies an answer by (the inbox, the hub's composer, the staged and drafted sends, the CLI and
 * the dashboard): whether an answer may be taken, and why not, as one closed reason. The store's transition table
 * stays the authority on states; these rules read it through `awaitsAnswer` and the delivered states below.
 */

/** Why an answer cannot be taken. Each code has one sentence, the same at every door. */
export type AnswerRefusalCode =
    /** Neither a letter nor a text. */
    | "empty"
    /** The option is not letters a-z. */
    | "option-shape"
    /** The agent posted a new text since the answer was picked. */
    | "stale-revision"
    /** No stored row and no transcript block has this number in the session. */
    | "not-waiting"
    /** A letter past the decision's options. */
    | "option-range"
    /** The decision was answered (or dismissed, superseded) already. */
    | "already-answered"
    /** The row a door holds no longer matches the log (another session, number, revision or answer). */
    | "changed-elsewhere";

export class AnswerRefusedError extends Error {
    constructor(
        readonly code: AnswerRefusalCode,
        message: string
    ) {
        super(message);
        this.name = "AnswerRefusedError";
    }
}

/** One decision's answer: a letter, a text, or a letter with a note. */
export interface DecisionAnswer {
    expectedRevision?: number;
    number: number;
    /** One letter, a-z. Required unless `text` is given. */
    option?: string;
    /** A free-text answer, or a note after the letter. */
    text?: string;
}

/** An answer that passed every rule, with the row (or the transcript block) it answers. */
export interface CheckedAnswer {
    expectedRevision: number;
    number: number;
    option?: string;
    text?: string;
    row?: DecisionRecord;
    block?: HarvestedDecision;
}

/** The session's decision row with this number, if the log has one. */
export function decisionRow(rows: DecisionRecord[], session: string, number: number): DecisionRecord | undefined {
    return rows.find((row) => row.sessionId === session && row.number === number && kindOf(row) === "decision");
}

/**
 * Checks one answer against its stored row, else its transcript block (`block` is asked only when the log has no
 * row); throws `AnswerRefusedError` with the closed reason.
 */
export async function checkAnswer({
    session,
    answer,
    rows,
    block,
}: {
    session: string;
    answer: DecisionAnswer;
    rows: DecisionRecord[];
    block: (session: string, number: number) => Promise<HarvestedDecision | null>;
}): Promise<CheckedAnswer> {
    // The decision log allows several letters ("ac" when two apply); each must name an option.
    const option = optionLetters(answer.option).join("") || undefined;
    const text = answer.text?.trim() || undefined;

    if (!option && !text) {
        throw new AnswerRefusedError("empty", `DECISION ${answer.number}: pass an option letter or an answer text`);
    }

    if (answer.option?.trim() && !/^[a-z]+$/i.test(answer.option.trim())) {
        throw new AnswerRefusedError("option-shape", `the option is one or more letters a-z, not "${answer.option}"`);
    }

    const row = decisionRow(rows, session, answer.number);
    if (
        answer.expectedRevision !== undefined &&
        (!Number.isInteger(answer.expectedRevision) ||
            answer.expectedRevision < 1 ||
            answer.expectedRevision !== (row?.revision ?? 1))
    ) {
        throw new AnswerRefusedError("stale-revision", staleRevisionError(answer.number).message);
    }

    const found = row ? null : await block(session, answer.number);

    if (!row && !found) {
        throw new AnswerRefusedError("not-waiting", `DECISION ${answer.number} is not waiting in session ${session}`);
    }

    const options = row?.options ?? found?.options ?? [];

    if (option && options.length > 0 && [...option].some((letter) => letter.charCodeAt(0) - 97 >= options.length)) {
        throw new AnswerRefusedError(
            "option-range",
            `DECISION ${answer.number} has options a-${String.fromCharCode(96 + options.length)}`
        );
    }

    if (row && !awaitsAnswer(row)) {
        throw new AnswerRefusedError("already-answered", `DECISION ${answer.number} is already ${row.state}`);
    }

    return {
        number: answer.number,
        option,
        text,
        expectedRevision: answer.expectedRevision ?? row?.revision ?? 1,
        ...(row ? { row } : {}),
        ...(found ? { block: found } : {}),
    };
}

/** The states a decision reaches once its answer was typed into the agent. */
const DELIVERED_STATES: ReadonlySet<DecisionState> = new Set(["sent", "acknowledged", "implemented"]);

/** Whether the decision's answer reached its agent. */
export function answerDelivered(row: Pick<DecisionRecord, "state">): boolean {
    return DELIVERED_STATES.has(row.state);
}

/** The answer a door holds for one decision: the revision it read, the letters it picked, the note it wrote. */
export interface HeldAnswer {
    expectedRevision: number;
    option?: string;
    text: string;
}

/**
 * The row holds this answer, stored by an earlier attempt: answering keeps the revision, so the same revision, the
 * same letter and the same note mean nobody answered it differently since.
 */
export function holdsAnswer(row: DecisionRecord, held: HeldAnswer): boolean {
    const option = held.option?.trim().toLowerCase() || undefined;
    const note = held.text.trim();
    return (
        (row.revision ?? 1) === held.expectedRevision &&
        (row.option || undefined) === option &&
        (!note || (row.answer ?? "").includes(note))
    );
}

/** A door's answer to one decision of one session, as the widget's composer sends it. */
export interface DoorAnswer extends HeldAnswer {
    session: string;
    number: number;
    /** The harness the door addresses; a row spelling it `claude-code` (the runtime context's name) still matches. */
    provider: string;
}

/**
 * Whether a door may send this answer for this row before it attempts anything: the row is this session's decision
 * with this number and revision, and it still waits for an answer, or it already holds this very answer (a refused
 * transport left it `answered`, so a Retry sends it again; a delivery from elsewhere settles it).
 */
export function doorAnswerRefusal(row: DecisionRecord | undefined, answer: DoorAnswer): AnswerRefusedError | undefined {
    const matches =
        row !== undefined &&
        kindOf(row) === "decision" &&
        row.sessionId === answer.session &&
        row.number === answer.number &&
        (!row.provider || (canonicalAgent(row.provider) ?? row.provider) === answer.provider) &&
        (row.revision ?? 1) === answer.expectedRevision &&
        (awaitsAnswer(row) || ((row.state === "answered" || answerDelivered(row)) && holdsAnswer(row, answer)));

    return matches
        ? undefined
        : new AnswerRefusedError(
              "changed-elsewhere",
              "The decision changed or belongs to another session; refresh it before answering."
          );
}

/**
 * What sending a door's answer comes to now, read from the row as it stands: `delivered` (this answer reached the
 * agent already, from another door), `resend` (this answer is stored `answered` and no receiver took it), `answer`
 * (the decision still waits: apply the answer, then send it), `unresolved` (an earlier delivery of it has an unknown
 * outcome: nothing may send it until someone looks at the conversation), or a refusal.
 */
export type DoorAnswerPlan =
    | { kind: "unresolved" }
    | { kind: "delivered" }
    | { kind: "resend"; row: DecisionRecord }
    | { kind: "answer" }
    | { kind: "refused"; refusal: AnswerRefusedError };

export function planDoorAnswer(row: DecisionRecord | undefined, answer: HeldAnswer): DoorAnswerPlan {
    if (row?.delivery?.uncertain) {
        return { kind: "unresolved" };
    }

    const ours = row !== undefined && holdsAnswer(row, answer);

    if (row && ours && answerDelivered(row)) {
        return { kind: "delivered" };
    }

    if (row && ours && row.state === "answered") {
        return { kind: "resend", row };
    }

    if (row && awaitsAnswer(row)) {
        return { kind: "answer" };
    }

    return {
        kind: "refused",
        refusal: new AnswerRefusedError(
            "changed-elsewhere",
            "Decision changed elsewhere. Refresh it before answering."
        ),
    };
}

/**
 * Delivers a session's answered decisions: the batch is marked `sent` in ONE store transition
 * FIRST, and only then handed to `emit`. Marking row by row after emitting let a crash leave
 * delivered answers still `answered`, and the next send delivered them again. Both the CLI and
 * the MCP door send through this. Throws "nothing to send" before any change when none is due.
 * An `emit` that throws puts the batch back to `answered`; one that returns normally delivered it.
 */
export async function sendSessionDecisions({
    file,
    events,
    session,
    ids: selectedIds,
    emit,
}: {
    file: string;
    events: string;
    session: string;
    ids?: readonly string[];
    /**
     * Returns (or resolves) when delivered; throws (or rejects) when not. Its value is ignored.
     * `numbers` are the decisions in `text`, for a caller that frames the message.
     */
    emit: (text: string, numbers: number[]) => unknown;
}): Promise<SentDecisions> {
    const selected = selectedIds ? new Set(selectedIds) : undefined;
    // Without ids: only the answers waiting to go out, never a chat answer an agent recorded as `answered`.
    const rows = readDecisions(file).filter(
        (row) =>
            row.sessionId === session &&
            kindOf(row) === "decision" &&
            (selected ? selected.has(row.id) : awaitsDelivery(row))
    );
    const due = deliverDecisions(rows, () => undefined);
    const ids = rows.filter((row) => due.numbers.includes(row.number)).map((row) => row.id);
    // The text comes from the rows as they stood UNDER the lock, not from the read above: an
    // answer edited in between would otherwise be marked sent while the old one was delivered.
    const moved = await moveDecisions(file, events, ids, "sent");
    const sent = { text: decisionLines(moved), numbers: moved.map((row) => row.number) };

    try {
        await emit(sent.text, sent.numbers);
    } catch (error) {
        if (!(error instanceof DeliveryUnknownError)) {
            const queued = error instanceof NotDeliveredError && error.result.queueId ? error.result : undefined;
            await restoreUndelivered({
                file,
                events,
                ids,
                ...(queued ? { delivery: { route: "queued", queueId: queued.queueId, error: queued.error } } : {}),
            });
        }
        throw error;
    }

    return sent;
}

export interface SentDecisions {
    text: string;
    numbers: number[];
}
